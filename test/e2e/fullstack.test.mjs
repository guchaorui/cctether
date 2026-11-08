// Full stack: headless Chrome + the real extension + the real server, driven through `cctether mcp`
// exactly like Claude Code does (SPEC §9).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchChrome } from './lib/chrome.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'server/bin/cctether.js');
const EXT_DIR = join(ROOT, 'extension');
const EXT_ID = 'nfebjhhcnoilmfjacolkofphfekkjioh';
const run = promisify(execFile);

let home, port, chrome, sw, page, mcp, http, base;

async function freePort() {
  const s = createNetServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// A person's terminal, not a command Claude Code runs (there `pair` refuses to print the code).
const termEnv = () => { const env = { ...process.env, CCTETHER_HOME: home }; delete env.CLAUDECODE; return env; };
const cli = (...args) => run(process.execPath, [CLI, ...args], { env: termEnv() }).catch((e) => e);

function mcpClient() {
  const p = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, CCTETHER_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const waiting = new Map();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    }
  });
  let id = 0;
  const request = (method, params, ms = 30000) => {
    const myId = ++id;
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    return new Promise((resolve, reject) => {
      waiting.set(myId, resolve);
      setTimeout(() => reject(new Error(`no reply to ${method} ${JSON.stringify(params)}`)), ms);
    });
  };
  return {
    request,
    async call(name, args = {}, ms) {
      const r = await request('tools/call', { name, arguments: args }, ms);
      if (r.error) throw new Error(`${name}: ${r.error.message}`);
      return r.result;
    },
    close: () => p.stdin.end(),
  };
}

const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

/** Send a UI command from an extension page, like the popup does. */
const ui = (msg) => page.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(msg)})`);
const extStatus = () => sw.evaluate('self.cctether.getStatus()');

async function waitFor(fn, what, ms = 15000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const waitConn = (conn, pred = () => true, ms) =>
  waitFor(async () => { const s = await extStatus(); return s.conn === conn && pred(s) ? s : null; }, `extension ${conn}`, ms);

before(async () => {
  home = join(mkdtempSync(join(tmpdir(), 'cct-e2e-')), 'home');
  port = await freePort();
  await cli('init', '--port', String(port));

  http = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url.startsWith('/form')) {
      res.end(`<!doctype html><title>Form page</title>
        <h1>Sign up</h1>
        <label>Email <input id="email" name="email"></label>
        <button id="go" onclick="document.getElementById('out').textContent = 'Hello ' + document.getElementById('email').value; console.log('clicked go')">Go</button>
        <p id="out"></p>
        <script>console.warn('form page loaded')</script>`);
    } else {
      res.end('<!doctype html><title>Other</title><p>other page</p>');
    }
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${http.address().port}`;

  mcp = mcpClient(); // starts the service
  const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'cctether');

  chrome = await launchChrome({ extensions: [EXT_DIR] });
  assert.equal(chrome.extensionIdsByPath[EXT_DIR], EXT_ID);
  sw = await chrome.extensionWorker(EXT_ID);
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/options/options.html` });
  page = await chrome.cdp.attach(targetId);
  await waitFor(() => page.evaluate('document.readyState === "complete"'), 'options page');
});

after(async () => {
  mcp?.close();
  await chrome?.close();
  await cli('stop');
  http?.close();
  if (home) rmSync(join(home, '..'), { recursive: true, force: true });
});

test('before pairing: tools say no browser is connected', async () => {
  assert.equal((await extStatus()).conn, 'unpaired');
  const r = await mcp.call('list_tabs');
  assert.equal(r.isError, true);
  assert.match(text(r), /No browser is connected/);
});

test('pairing with a bad code is refused; with the real code it connects', async () => {
  assert.deepEqual(await ui({ type: 'pair', code: 'cctether1:nonsense' }), { ok: false, error: 'invalid_code' });
  const code = (await cli('pair')).stdout.trim();
  const r = await ui({ type: 'pair', code });
  assert.equal(r.ok, true);
  assert.match(r.fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(r.server, `127.0.0.1:${port}`);
  const st = await waitConn('connected');
  assert.ok(st.serverVersion);
  const status = JSON.parse((await cli('status', '--json')).stdout);
  assert.equal(status.browser.connected, true);
  assert.match(status.browser.info.browser, /\d/);
  const stored = await sw.evaluate('chrome.storage.local.get("pairing").then(x => x.pairing)');
  assert.equal(stored.fingerprint, r.fingerprint);
});

test('tools work end to end through MCP', async () => {
  const empty = await mcp.call('list_tabs');
  assert.ok(!empty.isError, text(empty));

  const opened = await mcp.call('open_tab', { url: `${base}/form` });
  assert.ok(!opened.isError, text(opened));
  const tabId = Number(text(opened).match(/\d+/)[0]);

  const listed = text(await mcp.call('list_tabs'));
  assert.match(listed, /Form page/);

  const inter = await mcp.call('read_page', { mode: 'interactive' });
  assert.ok(!inter.isError, text(inter));
  assert.match(text(inter), /untrusted/i);
  const emailRef = Number(text(inter).match(/\[(\d+)\][^\n]*(?:textbox|input)[^\n]*Email/i)?.[1]);
  const goRef = Number(text(inter).match(/\[(\d+)\][^\n]*button[^\n]*Go/i)?.[1]);
  assert.ok(emailRef && goRef, text(inter));

  assert.ok(!(await mcp.call('type', { ref: emailRef, text: 'ada@example.com' })).isError);
  assert.ok(!(await mcp.call('click', { ref: goRef })).isError);
  const after = text(await mcp.call('read_page', {}));
  assert.match(after, /Hello ada@example\.com/);

  const shot = await mcp.call('screenshot', {});
  const img = shot.content.find((c) => c.type === 'image');
  assert.ok(img && img.data.length > 1000);
  assert.match(img.mimeType, /image\/(jpeg|png)/);

  const cons = text(await mcp.call('console_messages', {}));
  assert.match(cons, /clicked go/);
  assert.match(cons, /form page loaded/);

  const ev = text(await mcp.call('evaluate', { expression: 'document.title + "!"' }));
  assert.match(ev, /Form page!/);

  // The popup's activity log saw these calls.
  const activity = await sw.evaluate('chrome.storage.session.get("activity").then(x => x.activity)');
  assert.ok(activity.some((a) => a.tool === 'click' && a.ok && a.tab?.id === tabId));
});

test('tabs outside the cctether group are refused', async () => {
  const { targetId } = await chrome.cdp.send('Target.createTarget', { url: `${base}/other` });
  await sleep(500);
  const tabId = await sw.evaluate(`chrome.tabs.query({}).then(ts => ts.find(t => t.url.endsWith('/other')).id)`);
  const r = await mcp.call('read_page', { tab: tabId });
  assert.equal(r.isError, true);
  assert.match(text(r), /share|group/i);
  // The user shares it from the popup; now it works.
  assert.deepEqual(await ui({ type: 'shareTab', tabId }), { ok: true });
  const ok = await mcp.call('read_page', { tab: tabId });
  assert.ok(!ok.isError, text(ok));
  assert.match(text(ok), /other page/);
  assert.equal((await ui({ type: 'tabInfo', tabId })).shared, true);
  await ui({ type: 'unshareTab', tabId });
  assert.equal((await mcp.call('read_page', { tab: tabId })).isError, true);
  await chrome.cdp.send('Target.closeTarget', { targetId });
});

test('pause refuses every tool until resumed', async () => {
  await ui({ type: 'setPaused', paused: true });
  const r = await mcp.call('list_tabs');
  assert.equal(r.isError, true);
  assert.match(text(r), /paused/);
  assert.equal(await sw.evaluate('self.cctether.getStatus().attachedTabs'), 0, 'pausing detaches the debugger');
  await ui({ type: 'setPaused', paused: false });
  assert.ok(!(await mcp.call('list_tabs')).isError);
});

test('the extension reconnects after the service restarts', async () => {
  await cli('stop');
  await waitConn('disconnected');
  // The next MCP call restarts the service via the shim; the extension comes back on its own.
  await mcp.request('tools/list', {});
  await waitConn('connected', () => true, 40000);
  assert.ok(!(await mcp.call('list_tabs')).isError);
});

test('losing the network shows "offline" at once and reconnects when it is back', async () => {
  await waitConn('connected');
  const net = (offline) => sw.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sw.send('Network.enable');
  try {
    const t0 = Date.now();
    await net(true);
    const st = await waitConn('disconnected', (s) => s.error?.code === 'offline', 5000);
    assert.ok(Date.now() - t0 < 3000, `offline shown after ${Date.now() - t0} ms`);
    assert.equal(st.retryAt, null);
  } finally {
    await net(false);
  }
  await waitConn('connected', () => true, 10000);
  await sw.send('Network.disable');
});

test('a second browser replaces this one; reconnect takes it back', async () => {
  const { WebSocket } = await import(join(ROOT, 'server/node_modules/ws/wrapper.mjs'));
  const { Connection } = await import(join(ROOT, 'extension/background/connection.js'));
  const { parsePairingCode } = await import(join(ROOT, 'extension/shared/pairing.js'));
  const code = (await cli('pair')).stdout.trim();
  const p = parsePairingCode(code);
  let other;
  const otherConnected = new Promise((resolve) => {
    other = new Connection({
      createSocket: (u) => new WebSocket(u, { origin: `chrome-extension://${EXT_ID}` }),
      onStatus: (s) => { if (s.conn === 'connected') resolve(); },
      onCall: async () => ({ ok: true, data: { content: [{ type: 'text', text: 'other browser' }] } }),
      getInfo: () => ({ extension: '0', browser: 'Other', platform: 'test' }),
    });
    other.start({ url: p.url, key: p.key });
  });
  await otherConnected;
  await waitConn('replaced');
  await sleep(1500);
  assert.equal((await extStatus()).conn, 'replaced', 'no automatic retry');
  other.stop();
  await ui({ type: 'reconnect' });
  await waitConn('connected');
});

test('after `cctether rotate` the old pairing fails; pairing again fixes it', async () => {
  await cli('rotate');
  const st = await waitConn('disconnected', (s) => s.error?.code === 'server_auth_failed');
  assert.ok(st.retryAt > Date.now() + 60_000);
  const code = (await cli('pair')).stdout.trim();
  assert.equal((await ui({ type: 'pair', code })).ok, true);
  await waitConn('connected');
  assert.ok(!(await mcp.call('list_tabs')).isError);
});

test('unpairing disconnects and forgets the key', async () => {
  assert.deepEqual(await ui({ type: 'unpair' }), { ok: true });
  await waitConn('unpaired');
  assert.equal(await sw.evaluate('chrome.storage.local.get("pairing").then(x => x.pairing ?? null)'), null);
  const r = await mcp.call('list_tabs');
  assert.match(text(r), /No browser is connected/);
});

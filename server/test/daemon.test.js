// The resident service end to end: control socket, `cctether mcp`, admin commands, permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, statSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { makeExtension, sleep } from './helpers.js';
import { decodePairingCode } from '../src/pairing.js';

const CLI = fileURLToPath(new URL('../bin/cctether.js', import.meta.url));
const run = promisify(execFile);

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

function cli(home, ...args) {
  return run(process.execPath, [CLI, ...args], { env: { ...process.env, CCTETHER_HOME: home } }).catch((e) => e);
}

/** Talk MCP to `cctether mcp` over stdio. */
function mcpClient(home) {
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
  return {
    proc: p,
    request(method, params, ms = 8000) {
      const myId = ++id;
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
      return new Promise((resolve, reject) => {
        waiting.set(myId, resolve);
        setTimeout(() => reject(new Error(`no reply to ${method}`)), ms);
      });
    },
    close() { p.stdin.end(); },
  };
}

test('cctether mcp starts the service, which serves MCP and admin commands', async (t) => {
  const home = join(mkdtempSync(join(tmpdir(), 'cct-')), 'home');
  const port = await freePort();
  const init = await cli(home, 'init', '--port', String(port));
  assert.match(init.stdout, /Created/);

  const mcp = mcpClient(home);
  t.after(async () => { mcp.close(); await cli(home, 'stop'); });
  const init1 = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init1.result.serverInfo.name, 'cctether');
  const list = await mcp.request('tools/list', {});
  assert.equal(list.result.tools.length, 20);

  // Permissions: only this user can reach the control socket or read the key.
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'control.sock')).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, 'daemon.log')).mode & 0o777, 0o600);

  // No browser yet.
  const r1 = await mcp.request('tools/call', { name: 'list_tabs', arguments: {} });
  assert.equal(r1.result.isError, true);
  assert.match(r1.result.content[0].text, /No browser is connected/);

  // Pair a (simulated) extension using the code `cctether pair` prints.
  const pair = await cli(home, 'pair');
  const code = pair.stdout.trim();
  const { url, key } = decodePairingCode(code);
  assert.equal(url, `ws://127.0.0.1:${port}/cctether`);
  assert.doesNotMatch(pair.stderr, new RegExp(key.toString('base64url')), 'the key itself is only in the code on stdout');
  const ext = makeExtension({ url, key });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  t.after(() => ext.stop());

  const r2 = await mcp.request('tools/call', { name: 'list_tabs', arguments: {} });
  assert.deepEqual(r2.result, { content: [{ type: 'text', text: 'list_tabs:{}' }] });

  // A second MCP client shares the same service and browser.
  const mcp2 = mcpClient(home);
  t.after(() => mcp2.close());
  const r3 = await mcp2.request('tools/call', { name: 'find', arguments: { selector: 'h1' } });
  assert.deepEqual(r3.result.content[0].text, 'find:{"selector":"h1"}');

  const status = JSON.parse((await cli(home, 'status', '--json')).stdout);
  assert.equal(status.running, true);
  assert.equal(status.browser.connected, true);
  assert.equal(status.mcpSessions, 2);
  assert.equal(status.port, port);
  assert.equal(JSON.stringify(status).includes(key.toString('base64url')), false, 'status never shows the key');

  // A second service refuses to start while this one runs.
  const second = await cli(home, 'daemon');
  assert.match(second.stderr, /already running/);

  // rotate: the browser is dropped and its old code stops working.
  const rot = await cli(home, 'rotate');
  assert.match(rot.stdout, /New key made/);
  await ext.waitFor((s) => s.conn === 'disconnected' && s.error?.code === 'server_auth_failed', 5000);
  const r4 = await mcp.request('tools/call', { name: 'list_tabs', arguments: {} });
  assert.match(r4.result.content[0].text, /No browser is connected/);
});

test('cctether mcp survives a service restart', async (t) => {
  const home = join(mkdtempSync(join(tmpdir(), 'cct-')), 'home');
  const port = await freePort();
  await cli(home, 'init', '--port', String(port));
  const mcp = mcpClient(home);
  t.after(async () => { mcp.close(); await cli(home, 'stop'); });
  assert.equal((await mcp.request('tools/list', {})).result.tools.length, 20);
  await cli(home, 'stop');
  await sleep(300);
  // The shim notices, restarts the service and carries on.
  const again = await mcp.request('tools/list', {}, 15000);
  assert.equal(again.result.tools.length, 20);
  const st = JSON.parse((await cli(home, 'status', '--json')).stdout);
  assert.equal(st.running, true);
});

test('pair --url saves a public address; bad URLs are refused', async () => {
  const home = join(mkdtempSync(join(tmpdir(), 'cct-')), 'home');
  const bad = await cli(home, 'pair', '--url', 'ws://browser.example.com/cctether');
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /wss:\/\//);
  const ok = await cli(home, 'pair', '--url', 'wss://browser.example.com/cctether');
  assert.equal(decodePairingCode(ok.stdout.trim()).url, 'wss://browser.example.com/cctether');
  const again = await cli(home, 'pair');
  assert.equal(decodePairingCode(again.stdout.trim()).url, 'wss://browser.example.com/cctether');
  assert.ok(existsSync(join(home, 'config.json')));
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).publicUrl, 'wss://browser.example.com/cctether');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpSession, sanitizeContent, lineSplitter, compareVersions, minExtensionFor } from '../src/mcp.js';
import { GatewayError } from '../src/gateway.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function session(browser) {
  const out = [];
  const s = createMcpSession({ write: (l) => out.push(JSON.parse(l)), browser, version: '1.2.3' });
  return { out, send: (m) => s.handleLine(typeof m === 'string' ? m : JSON.stringify(m)) };
}

test('initialize and tools/list', async () => {
  const { out, send } = session(null);
  await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(out[0].result.protocolVersion, '2025-06-18');
  assert.equal(out[0].result.serverInfo.name, 'cctether');
  assert.match(out[0].result.instructions, /untrusted/);
  await send({ jsonrpc: '2.0', id: 'x', method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(out[1].result.protocolVersion, '2025-11-25');
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(out.length, 2, 'no reply to notifications');
  await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(out[2].result.tools.length, 22);
  await send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual(out[3], { jsonrpc: '2.0', id: 3, result: {} });
  await send({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
  assert.equal(out[4].error.code, -32601);
  await send('{nope');
  assert.equal(out[5].error.code, -32700);
});

test('tools/call: validation, success, errors', async () => {
  const calls = [];
  const browser = {
    async call(tool, args, timeoutMs) {
      calls.push({ tool, args, timeoutMs });
      if (tool === 'close_tab') return { ok: false, error: { code: 'not_shared', message: 'Tab 5 is not shared.' } };
      if (tool === 'wait_for') throw new GatewayError('timeout', 'The browser did not answer within 20 s.');
      return { ok: true, data: { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }, { type: 'evil', x: 1 }] } };
    },
  };
  const { out, send } = session(browser);
  await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screenshot', arguments: { full_page: true } } });
  assert.deepEqual(out[0].result, { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] });
  assert.equal(calls[0].timeoutMs, 30000);
  await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'screenshot', arguments: { full_page: 'yes' } } });
  assert.equal(out[1].result.isError, true);
  assert.match(out[1].result.content[0].text, /full_page must be boolean/);
  assert.equal(calls.length, 1, 'invalid calls never reach the browser');
  await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rm_rf' } });
  assert.equal(out[2].error.code, -32602);
  await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'close_tab', arguments: { tab: 5 } } });
  assert.deepEqual(out[3].result, { content: [{ type: 'text', text: 'Tab 5 is not shared.' }], isError: true });
  await send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'wait_for', arguments: { text: 'x', timeout_ms: 15000 } } });
  assert.equal(calls.at(-1).timeoutMs, 20000);
  assert.match(out[4].result.content[0].text, /did not answer/);
});

test('tools/call with no browser explains what the user should do', async () => {
  const { out, send } = session({ call: async () => { throw new GatewayError('no_browser', 'x'); } });
  await send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } });
  assert.equal(out[0].result.isError, true);
  assert.match(out[0].result.content[0].text, /No browser is connected[\s\S]*cctether pair/);
});

test('tools/call: an extension older than the server gets a clear "update the extension" message', async () => {
  // What an extension before 0.4.0 answers for resize_viewport (extension/background/app.js onCall).
  const unknown = { ok: false, error: { code: 'bad_args', message: 'Unknown tool "resize_viewport". Update the cctether extension?' } };
  const answer = async (tool) => (tool === 'resize_viewport' ? unknown : { ok: false, error: { code: 'bad_args', message: '`x` must be a number.' } });

  const withStatus = session({ call: answer, status: () => ({ connected: true, info: { extension: '0.3.3', browser: 'Chrome 156' } }) });
  await withStatus.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'resize_viewport', arguments: { width: 390 } } });
  assert.equal(withStatus.out[0].result.isError, true);
  assert.equal(withStatus.out[0].result.content[0].text,
    'resize_viewport is not supported by the connected cctether browser extension (version 0.3.3; this server is 1.2.3). '
    + 'The extension is older than the server: ask the user to update it (chrome://extensions → Developer mode → Update). '
    + 'If the Chrome Web Store does not have the new version yet, this tool can\'t be used for now.');

  // Any other bad_args answer from an older extension says the argument may be newer than it.
  await withStatus.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'click', arguments: { x: 1, y: 2 } } });
  assert.deepEqual(withStatus.out[1].result, {
    content: [{
      type: 'text',
      text: '`x` must be a number.\n(The connected cctether browser extension is version 0.3.3, older than this server, 1.2.3: this argument or value may be newer than the extension. '
        + 'Ask the user to update the extension; until then, use the arguments the error says it accepts.)',
    }],
    isError: true,
  });
  // From an extension as new as the server (or newer), it passes through unchanged.
  for (const extension of ['1.2.3', '1.10.0']) {
    const same = session({ call: answer, status: () => ({ connected: true, info: { extension } }) });
    await same.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'click', arguments: { x: 1, y: 2 } } });
    assert.deepEqual(same.out[0].result, { content: [{ type: 'text', text: '`x` must be a number.' }], isError: true });
  }

  // A browser object without status() (or without info yet): the version is "unknown".
  const bare = session({ call: answer });
  await bare.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'resize_viewport', arguments: { reset: true } } });
  assert.equal(bare.out[0].result.isError, true);
  assert.match(bare.out[0].result.content[0].text, /^resize_viewport is not supported by the connected cctether browser extension \(version unknown; this server is 1\.2\.3\)\. .*ask the user to update it/);
  const noInfo = session({ call: answer, status: () => ({ connected: false }) });
  await noInfo.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'resize_viewport', arguments: { width: 400 } } });
  assert.match(noInfo.out[0].result.content[0].text, /\(version unknown; this server is 1\.2\.3\)/);
});

test('tools/call: a call an older extension would quietly answer differently is refused by version', async () => {
  const calls = [];
  const call = async (tool, args) => { calls.push({ tool, args }); return { ok: true, data: { content: [{ type: 'text', text: 'done' }] } }; };
  const old = session({ call, status: () => ({ connected: true, info: { extension: '0.4.0' } }) });
  // Before 0.5.0, screenshot with an element and full_page returned only the element's visible part.
  await old.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screenshot', arguments: { selector: '#pane', full_page: true } } });
  assert.equal(old.out[0].result.isError, true);
  assert.match(old.out[0].result.content[0].text, /^A screenshot of an element's whole scrollable content \(full_page with ref or selector\) needs the cctether browser extension 0\.5\.0 or newer; the connected one is 0\.4\.0 \(this server is 1\.2\.3\)\. Ask the user to update the extension\. Until then: /);
  assert.equal(calls.length, 0, 'not sent to the extension');
  // The same tool otherwise, and the combination with a new enough extension, go through.
  await old.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'screenshot', arguments: { full_page: true } } });
  await old.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screenshot', arguments: { ref: 3, full_page: false } } });
  const fresh = session({ call, status: () => ({ connected: true, info: { extension: '0.5.0' } }) });
  await fresh.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screenshot', arguments: { ref: 3, full_page: true } } });
  // Without a known extension version, cctether can't tell: it sends the call.
  const unknown = session({ call });
  await unknown.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screenshot', arguments: { ref: 3, full_page: true } } });
  assert.deepEqual(calls.map((c) => c.args), [{ full_page: true }, { ref: 3, full_page: false }, { ref: 3, full_page: true }, { ref: 3, full_page: true }]);
  assert.equal(fresh.out[0].result.content[0].text, 'done');
});

test('compareVersions and minExtensionFor', () => {
  assert.ok(compareVersions('0.4.0', '0.5.0') < 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.5.0', '0.5'), 0);
  assert.ok(compareVersions('1.0.0-beta', '1.0.1') < 0);
  assert.equal(minExtensionFor('screenshot', { full_page: true }), null);
  assert.equal(minExtensionFor('screenshot', { selector: 'x' }), null);
  assert.equal(minExtensionFor('screenshot', { selector: 'x', full_page: true }).version, '0.5.0');
  assert.equal(minExtensionFor('click', { selector: 'x', full_page: true }), null);
});

test('sanitizeContent drops malformed items', () => {
  assert.deepEqual(sanitizeContent(undefined), [{ type: 'text', text: '(no output)' }]);
  assert.deepEqual(sanitizeContent([{ type: 'image', data: 'not base64!', mimeType: 'image/png' }, { type: 'image', data: 'AAAA', mimeType: 'text/html' }]), [{ type: 'text', text: '(no output)' }]);
});

test('lineSplitter handles split chunks and overflow', () => {
  const lines = [];
  let overflow = 0;
  const feed = lineSplitter((l) => lines.push(l), { maxLine: 10, onOverflow: () => overflow++ });
  feed('ab');
  feed('c\nde\n');
  feed('f');
  assert.deepEqual(lines, ['abc', 'de']);
  feed('x'.repeat(20));
  assert.equal(overflow, 1);
});

test('evaluate file: the service reads the script and sends it as expression', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cct-mcp-scripts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'hello.js'), 'document.title + "!"');
  const calls = [];
  const browser = { async call(tool, args) { calls.push({ tool, args }); return { ok: true, data: { content: [{ type: 'text', text: 'ran' }] } }; } };
  const out = [];
  const s = createMcpSession({ write: (l) => out.push(JSON.parse(l)), browser, version: '1.2.3', scriptsDir: dir });
  const send = (m) => s.handleLine(JSON.stringify(m));
  await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const ev = out[0].result.tools.find((x) => x.name === 'evaluate');
  assert.ok(ev.inputSchema.properties.file.description.includes(dir), 'the description names the directory');
  assert.equal(ev.inputSchema.required, undefined);
  await send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'evaluate', arguments: { file: 'hello.js', world: 'isolated' } } });
  assert.equal(out[1].result.content[0].text, 'ran');
  assert.deepEqual(calls, [{ tool: 'evaluate', args: { expression: 'document.title + "!"', world: 'isolated' } }]);
  for (const [args, re] of [
    [{ file: 'hello.js', expression: '1' }, /not both/],
    [{}, /Pass `expression`/],
    [{ file: '../x.js' }, /There is no file|not in cctether's scripts directory/],
    [{ file: 'nope.txt' }, /not a \.js file/],
  ]) {
    await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'evaluate', arguments: args } });
    const r = out.at(-1).result;
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, re);
  }
  assert.equal(calls.length, 1, 'refused calls never reach the browser');
  // A session without a scripts directory (the shim's fallback) has no `file` at all.
  const plain = session(null);
  await plain.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(plain.out[0].result.tools.find((x) => x.name === 'evaluate').inputSchema.properties.file, undefined);
});

test('evaluate file: the call goes only to the browser connection there was when it came', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cct-mcp-scripts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'a.js'), '1');
  const A = { id: 'A' };
  const seen = [];
  const browser = {
    browser: A,
    async call(tool, args, timeoutMs, opts) {
      seen.push(opts);
      if (opts && opts.connection !== this.browser) throw new GatewayError('disconnected', 'The browser connection changed while cctether was preparing the call, so nothing was run.');
      return { ok: true, data: { content: [{ type: 'text', text: 'ran' }] } };
    },
  };
  const out = [];
  const s = createMcpSession({ write: (l) => out.push(JSON.parse(l)), browser, version: '1.2.3', scriptsDir: dir });
  await s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'evaluate', arguments: { file: 'a.js' } } }));
  assert.equal(out[0].result.content[0].text, 'ran');
  assert.equal(seen[0].connection, A);
  // Another browser connected while the file was read: not sent to it.
  const p = s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'evaluate', arguments: { file: 'a.js' } } }));
  browser.browser = { id: 'B' };
  await p;
  assert.equal(out[1].result.isError, true);
  assert.match(out[1].result.content[0].text, /connection changed/);
  // A plain expression is not pinned.
  await s.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'evaluate', arguments: { expression: '1' } } }));
  assert.equal(seen.at(-1), undefined);
});

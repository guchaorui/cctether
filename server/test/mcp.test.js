import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpSession, sanitizeContent, lineSplitter } from '../src/mcp.js';
import { GatewayError } from '../src/gateway.js';

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
  assert.equal(out[2].result.tools.length, 20);
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

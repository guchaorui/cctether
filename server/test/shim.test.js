// `cctether mcp` across service restarts: telling the client when the tool list changed (SPEC §4.5).
// A fake service answers on the control socket; the shim runs as a child process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startControl } from '../src/control.js';
import { paths } from '../src/config.js';
import { lineSplitter } from '../src/mcp.js';
import { canonical, describeChange, createListWatch } from '../src/listwatch.js';
import { sleep } from './helpers.js';

const ENTRY = fileURLToPath(new URL('./fixtures/shim-entry.js', import.meta.url));
const GRACE = 300;

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'cct-shim-'));
  roots.push(root);
  const dir = join(root, 'h');
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

const tool = (name, props = {}, description = `The ${name} tool.`) => ({
  name, title: name, description, inputSchema: { type: 'object', properties: props }, annotations: { readOnlyHint: true },
});
const V1 = [tool('click', { ref: { type: 'string' } }), tool('evaluate', { expression: { type: 'string' } })];

/** A stand-in for the resident service: answers MCP on the control socket with the given tools. */
async function fakeService(dir, tools) {
  const seen = [];
  const answer = (socket, m) => {
    const reply = (result) => socket.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n');
    if (m.method === 'initialize') {
      reply({ protocolVersion: m.params?.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'cctether', version: '1.0.0' } });
    } else if (m.method === 'tools/list') {
      reply({ tools });
    } else if (m.method === 'tools/call') {
      const name = m.params?.name;
      if (name === 'fail') return socket.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool: fail' } }) + '\n');
      setTimeout(() => { if (!socket.destroyed) reply({ content: [{ type: 'text', text: `${name}:ok` }] }); }, name === 'slow' ? 5000 : 0);
    }
  };
  const ctl = await startControl({
    socketPath: paths(dir).socket,
    onAdmin: async () => ({ ok: true }),
    onMcp(socket, rest) {
      const feed = lineSplitter((line) => { const m = JSON.parse(line); seen.push(m); answer(socket, m); });
      socket.on('data', feed);
      if (rest) feed(rest);
    },
  });
  return {
    seen,
    close: () => ctl.close(),
    /** The tools/list the shim sent on its own after reconnecting, once it arrives. */
    async ownCheck(ms = 3000) {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
        const m = seen.find((x) => x.method === 'tools/list' && String(x.id).startsWith('cctether-shim-'));
        if (m) return m;
      }
      return null;
    },
  };
}

/** An MCP client talking to the shim over stdio. */
function shimClient(dir) {
  const p = spawn(process.execPath, [ENTRY, dir, String(GRACE)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let nextId = 1;
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', lineSplitter((l) => lines.push(JSON.parse(l))));
  const waitFor = async (pred, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
      const m = lines.find(pred);
      if (m) return m;
    }
    throw new Error(`timed out; got ${JSON.stringify(lines).slice(0, 2000)}`);
  };
  const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  return {
    lines,
    send,
    raw: (line) => p.stdin.write(line + '\n'),
    waitFor,
    async request(method, params = {}, ms) {
      const id = nextId++;
      send({ id, method, params });
      return waitFor((m) => m.id === id && !('method' in m), ms);
    },
    async handshake() {
      const r = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      send({ method: 'notifications/initialized' });
      return r;
    },
    listChanged: () => lines.filter((m) => m.method === 'notifications/tools/list_changed').length,
    close: () => { p.stdin.end(); p.kill(); },
  };
}

/** Swap the service for one with `tools`, as an upgrade does; resolves once the shim checked it. */
async function restart(dir, svc, tools, { checked = true } = {}) {
  await svc.close();
  await sleep(150);
  const next = await fakeService(dir, tools);
  if (checked) assert.ok(await next.ownCheck(), 'the shim checks the new service\'s tool list');
  return next;
}

const noteOf = (r) => r.result.content.slice(1).map((c) => c.text).join('\n');

async function setup(t) {
  const dir = tempDir();
  let svc = await fakeService(dir, V1);
  const c = shimClient(dir);
  t.after(async () => { c.close(); await svc?.close(); });
  const init = await c.handshake();
  const list = await c.request('tools/list');
  assert.equal(list.result.tools.length, 2);
  return { dir, c, init, get svc() { return svc; }, set svc(v) { svc = v; } };
}

test('the shim says it reports tool list changes; nothing happens if the list did not change', async (t) => {
  const s = await setup(t);
  assert.deepEqual(s.init.result.capabilities, { tools: { listChanged: true } });
  assert.deepEqual(s.init.result.serverInfo, { name: 'cctether', version: '1.0.0' }, 'the rest of the reply is untouched');
  // The same tools in another key order are the same list.
  const reordered = V1.map((x) => ({ annotations: x.annotations, inputSchema: x.inputSchema, description: x.description, title: x.title, name: x.name }));
  s.svc = await restart(s.dir, s.svc, reordered);
  await sleep(GRACE + 100);
  const r = await s.c.request('tools/call', { name: 'click', arguments: {} });
  assert.deepEqual(r.result.content, [{ type: 'text', text: 'click:ok' }], 'no note');
  assert.equal(s.c.listChanged(), 0);
  assert.equal(s.c.lines.some((m) => String(m.id).startsWith('cctether-shim-')), false, 'the shim\'s own replies stay inside');
});

test('a new tool: the client is told once, and gets no note after it fetched the list', async (t) => {
  const s = await setup(t);
  s.svc = await restart(s.dir, s.svc, [...V1, tool('drag')]);
  await s.c.waitFor((m) => m.method === 'notifications/tools/list_changed');
  const list = await s.c.request('tools/list');
  assert.deepEqual(list.result.tools.map((x) => x.name), ['click', 'evaluate', 'drag']);
  await sleep(GRACE + 100);
  const r = await s.c.request('tools/call', { name: 'drag', arguments: {} });
  assert.equal(r.result.content.length, 1, 'no note: the client has the new tool');
  assert.equal(s.c.listChanged(), 1);
});

test('a client that ignores the notification gets one note, on the first call after the grace period', async (t) => {
  const s = await setup(t);
  s.svc = await restart(s.dir, s.svc, [...V1, tool('drag')]);
  await s.c.waitFor((m) => m.method === 'notifications/tools/list_changed');
  const early = await s.c.request('tools/call', { name: 'click', arguments: {} });
  assert.equal(early.result.content.length, 1, 'too soon after the change: no note yet');
  await sleep(GRACE + 100);
  const r = await s.c.request('tools/call', { name: 'click', arguments: {} });
  assert.equal(r.result.content[0].text, 'click:ok');
  assert.match(noteOf(r), /^Note from cctether: the cctether service restarted with a different tool list/);
  assert.match(noteOf(r), /New tools: drag\. This session may not have them yet: to use them, ask the user to restart Claude Code/);
  const again = await s.c.request('tools/call', { name: 'click', arguments: {} });
  assert.equal(again.result.content.length, 1, 'only once');
});

test('a changed tool: the note gives its new arguments even after the client fetched the list', async (t) => {
  const s = await setup(t);
  const file = { type: 'string', description: 'A script file.' };
  s.svc = await restart(s.dir, s.svc, [V1[0], tool('evaluate', { expression: { type: 'string' }, file })]);
  await s.c.waitFor((m) => m.method === 'notifications/tools/list_changed');
  await s.c.request('tools/list');
  await sleep(GRACE + 100);
  // An error reply carries no note and doesn't use it up.
  const failed = await s.c.request('tools/call', { name: 'fail', arguments: {} });
  assert.equal(failed.error.message, 'Unknown tool: fail');
  const r = await s.c.request('tools/call', { name: 'evaluate', arguments: { expression: '1' } });
  const note = noteOf(r);
  assert.match(note, /\n- New arguments \(you can pass them even if your copy of the tool's schema doesn't list them\):\n  - file \(evaluate\): \{"type":"string","description":"A script file\."\}$/);
  assert.doesNotMatch(note, /New tools|restart Claude Code/, 'nothing else to say: the client has the list, and only an argument was added');
  const again = await s.c.request('tools/call', { name: 'evaluate', arguments: { expression: '1' } });
  assert.equal(again.result.content.length, 1);
});

test('back to the old list before any call: no note, no second notification', async (t) => {
  const s = await setup(t);
  s.svc = await restart(s.dir, s.svc, [V1[0]]);
  await s.c.waitFor((m) => m.method === 'notifications/tools/list_changed');
  s.svc = await restart(s.dir, s.svc, V1);
  await sleep(GRACE + 100);
  const r = await s.c.request('tools/call', { name: 'click', arguments: {} });
  assert.equal(r.result.content.length, 1);
  assert.equal(s.c.listChanged(), 1);
});

test('two restarts in a row: one note covers both changes', async (t) => {
  const s = await setup(t);
  s.svc = await restart(s.dir, s.svc, [...V1, tool('drag')]);
  await s.c.waitFor((m) => m.method === 'notifications/tools/list_changed');
  s.svc = await restart(s.dir, s.svc, [V1[0], tool('drag')]);
  await sleep(GRACE + 100);
  const r = await s.c.request('tools/call', { name: 'click', arguments: {} });
  assert.match(noteOf(r), /New tools: drag\./);
  assert.match(noteOf(r), /Removed tools: evaluate\./);
});

test('a call in flight during a restart gets an error; a restart before the handshake sends nothing extra', async (t) => {
  const dir = tempDir();
  let svc = await fakeService(dir, V1);
  const c = shimClient(dir);
  t.after(async () => { c.close(); await svc.close(); });
  const slow = c.request('tools/call', { name: 'slow', arguments: {} });
  // Restart only once the call has reached the service (a fixed wait was too short on a busy computer).
  for (const end = Date.now() + 5000; Date.now() < end && !svc.seen.some((m) => m.params?.name === 'slow'); await sleep(20));
  assert.ok(svc.seen.some((m) => m.params?.name === 'slow'), 'the call reached the service');
  svc = await restart(dir, svc, V1, { checked: false });
  const r = await slow;
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /restarted while this call was running/);
  const list = await c.request('tools/list');
  assert.equal(list.result.tools.length, 2);
  assert.equal(await svc.ownCheck(500), null, 'no handshake yet: nothing to check');
  assert.equal(c.listChanged(), 0);
});

test('canonical JSON and the change description', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: 2 }] }), canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]), 'array order counts');
  const ref = { type: 'string', description: 'An element.' };
  const before = [tool('click', { ref: { type: 'string' }, x: { type: 'number' } }), tool('hover', { ref: { type: 'string' } }), tool('gone')];
  const after = [tool('click', { ref }, 'Click better.'), tool('hover', { ref }), tool('fresh')];
  const text = describeChange(before, after);
  assert.match(text, /\n- New tools: fresh\. This session may not have them yet: to use them, ask the user to restart Claude Code or their MCP client\.\n/);
  assert.match(text, /\n- Changed arguments, as they are now:\n  - ref \(click, hover\): \{"type":"string","description":"An element\."\}\n/, 'one line for both tools');
  assert.match(text, /\n- Arguments no longer accepted:\n  - x \(click\)\n/);
  assert.match(text, /\n- Descriptions or other details changed: click\. To see the new ones, ask the user to restart Claude Code or their MCP client\.\n/);
  assert.match(text, /\n- Removed tools: gone\.$/);
  // An argument that becomes required is named with that.
  const req = (t, r) => ({ ...t, inputSchema: { ...t.inputSchema, required: r } });
  const path = { type: 'string' };
  const reqText = describeChange([tool('read', { path })], [req(tool('read', { path }), ['path'])]);
  assert.match(reqText, /\n- Changed arguments, as they are now:\n  - path \(read\), now required: \{"type":"string"\}$/);
  assert.doesNotMatch(reqText, /Descriptions or other details/);
  // Long: definitions are cut and stop when there is no room, but every name is kept.
  const many = Array.from({ length: 40 }, (_, i) => [`a${i}`, { type: 'string', description: 'x'.repeat(2000) }]);
  const long = describeChange([tool('t'), tool('gone')], [tool('t', Object.fromEntries(many))]);
  assert.ok(long.length <= 4100, `note length ${long.length}`);
  assert.match(long, /  - a39 \(t\)\n/, 'every argument is at least named');
  assert.match(long, /\n- Removed tools: gone\.$/);
  // Even the names too many: the last ones are counted, and removed tools are still named.
  const huge = Array.from({ length: 600 }, (_, i) => [`${'n'.repeat(40)}${i}`, { type: 'string' }]);
  const hugeText = describeChange([tool('t'), tool('gone')], [tool('t', Object.fromEntries(huge))]);
  assert.ok(hugeText.length <= 8300, `note length ${hugeText.length}`);
  assert.match(hugeText, /\n- Removed tools: gone\.\n- \(\d+ more changed arguments not listed\. To see them all, ask the user to restart Claude Code or their MCP client\.\)$/);
  // Very many tools: names up to a limit, then a count.
  const tools = Array.from({ length: 350 }, (_, i) => tool(`tool_with_a_long_name_${i}`));
  const gone = describeChange(tools, []);
  assert.ok(gone.length < 2000, `note length ${gone.length}`);
  assert.match(gone, /- Removed tools: tool_with_a_long_name_0, .* and \d+ more\.$/);
});

/** The watch on its own, with a clock. */
function watcher() {
  let t = 1000;
  let notified = 0;
  const w = createListWatch({ notify: () => notified++, graceMs: 100, now: () => t });
  w.reply({ method: 'initialize' }, { result: { capabilities: {} } });
  w.fromClient({ method: 'notifications/initialized' });
  return {
    w,
    get notified() { return notified; },
    tick(ms) { t += ms; },
    list(tools) { w.reply({ method: 'tools/list', at: t, cursor: false }, { result: { tools } }); },
    call() { const m = { result: { content: [{ type: 'text', text: 'ok' }] } }; w.reply({ method: 'tools/call', at: t }, m); return m.result.content.slice(1).map((c) => c.text).join(''); },
  };
}

test('watch: a tool first seen in a later list is remembered as that version', () => {
  // A has `existing`; B changes it and adds `fresh`, which the client fetches; C puts `existing`
  // back and changes `fresh`. The model has B's `fresh`, so it must hear about that change.
  const x = watcher();
  const existing = tool('existing', { a: { type: 'string' } });
  x.list([existing]);
  x.w.reconnected();
  x.w.serviceList([tool('existing', { a: { type: 'number' } }), tool('fresh', { v: { type: 'string' } })]);
  assert.equal(x.notified, 1);
  x.list([tool('existing', { a: { type: 'number' } }), tool('fresh', { v: { type: 'string' } })]);
  x.w.reconnected();
  x.w.serviceList([existing, tool('fresh', { v: { type: 'integer' } })]);
  x.list([existing, tool('fresh', { v: { type: 'integer' } })]);
  x.tick(200);
  const note = x.call();
  assert.match(note, /  - v \(fresh\): \{"type":"integer"\}/);
  assert.doesNotMatch(note, /existing/, 'existing is back to the version the model has');
});

test('watch: a different list after another restart starts the grace period again', () => {
  const x = watcher();
  x.list(V1);
  x.w.reconnected();
  x.w.serviceList([V1[0]]); // B: evaluate removed
  x.tick(200);
  x.w.reconnected(); // C, with yet another list
  x.w.serviceList([V1[0], tool('drag')]);
  assert.equal(x.call(), '', 'too soon after C\'s list was seen');
  x.tick(200);
  assert.match(x.call(), /Removed tools: evaluate/);
  // The same list again after a restart keeps its time.
  x.w.reconnected();
  x.w.serviceList(V1);
  x.tick(200);
  x.w.reconnected();
  x.w.serviceList(V1);
  assert.match(x.call(), /New tools: evaluate/);
});

test('a malformed cancel notification is passed on and does not break the shim', async (t) => {
  const s = await setup(t);
  s.c.send({ method: 'notifications/cancelled', params: 'oops' });
  s.c.send({ method: 'notifications/cancelled', params: { requestId: { weird: true } } });
  // A requestId nested too deep for JSON.stringify.
  s.c.raw(`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":${'{"d":'.repeat(20000)}1${'}'.repeat(20000)}}}`);
  const r = await s.c.request('tools/call', { name: 'click', arguments: {} });
  assert.equal(r.result.content[0].text, 'click:ok');
  await sleep(100);
  assert.equal(s.svc.seen.filter((m) => m.method === 'notifications/cancelled').length, 3, 'all passed on');
});

test('watch: after a reconnect, no note until the new service\'s list is seen', () => {
  const x = watcher();
  x.list(V1);
  x.w.reconnected();
  x.w.serviceList([V1[0]]); // evaluate removed
  x.tick(200);
  x.w.reconnected(); // the next service: its check fails or is slow
  assert.equal(x.call(), '', 'not confirmed: no note from the last service\'s list');
  x.w.serviceList(V1); // it is back to the old list
  assert.equal(x.call(), '');
  x.w.reconnected();
  x.w.serviceList([V1[0]]);
  x.tick(200);
  assert.match(x.call(), /Removed tools: evaluate\./);
});

test('a cancelled call does not use up the note', async (t) => {
  const s = await setup(t);
  s.svc = await restart(s.dir, s.svc, [V1[0], tool('evaluate', { expression: { type: 'string' }, file: { type: 'string' } })]);
  await s.c.waitFor((m) => m.method === 'notifications/tools/list_changed');
  await sleep(GRACE + 100);
  s.c.send({ id: 'slow-1', method: 'tools/call', params: { name: 'slow', arguments: {} } });
  s.c.send({ method: 'notifications/cancelled', params: { requestId: 'slow-1', reason: 'Esc' } });
  const late = await s.c.waitFor((m) => m.id === 'slow-1', 9000);
  assert.equal(late.result.content.length, 1, 'passed on as it is, without the note');
  const r = await s.c.request('tools/call', { name: 'click', arguments: {} });
  assert.match(noteOf(r), /- file \(evaluate\)/);
});

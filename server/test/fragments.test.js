// Messages from the server to the extension in fragments (upload_file, SPEC §4.4): the real
// gateway against the real extension connection code, and a fake server that breaks the rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { startGateway, makeExtension, sleep } from './helpers.js';
import { fragmentSlices } from '../src/gateway.js';
import {
  PROTO, LABEL_SERVER, b64u, fromB64u, proof, deriveSessionKeys, SessionCipher, MAX_TO_EXTENSION,
  MAX_FRAGMENTED_TO_EXTENSION,
} from '../src/protocol.js';

const MiB = 1024 * 1024;
const frameBytes = (s, i, n) => Buffer.byteLength(JSON.stringify({ t: 'frag', i, n, s })) + 16;

test('fragment slices: each sealed fragment fits a frame, counting UTF-8 bytes after quoting', () => {
  // Characters JSON makes 6 bytes of, 3-byte characters, and surrogate pairs at every offset.
  const text = JSON.stringify({ t: 'call', id: 1, tool: 'upload_file', args: { s: '\u0001'.repeat(300_000) + '中'.repeat(400_000) + '😀'.repeat(300_000) + 'A'.repeat(2 * MiB) } });
  const slices = fragmentSlices(text);
  assert.equal(slices.join(''), text);
  slices.forEach((s, i) => {
    assert.ok(frameBytes(s, i, slices.length) <= MAX_TO_EXTENSION, `fragment ${i} is ${frameBytes(s, i, slices.length)} bytes`);
    const last = s.charCodeAt(s.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `fragment ${i} ends in half a surrogate pair`);
  });
  // Mostly-ASCII content (base64) fills the frames.
  const b64 = JSON.stringify({ data: 'A'.repeat(20 * MiB) });
  const n = fragmentSlices(b64).length;
  assert.ok(n <= 21, `${n} fragments for 20 MiB`);
  // The limits: bytes of frames in all, and the number of fragments.
  assert.throws(() => fragmentSlices('A'.repeat(MAX_FRAGMENTED_TO_EXTENSION + 1)), /too large/);
  assert.throws(() => fragmentSlices('A'.repeat(3 * MiB), { maxCount: 2 }), /too large/);
});

test('an upload_file call bigger than a frame arrives intact; other calls stay limited to one frame', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const got = [];
  const ext = makeExtension({ url: g.url, key: g.key, onCall: async (tool, args) => { got.push({ tool, args }); return { ok: true, data: { content: [{ type: 'text', text: `${tool} done` }] } }; } });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  await sleep(50);
  assert.equal(g.gw.status().info.frag, true, 'the extension says it takes fragments');
  const args = { files: [{ name: '报告 "最终" 😀.pdf', type: 'application/pdf', data: randomBytes(6 * MiB).toString('base64') }], tab: 1, origin: 'https://example.com' };
  const r = await g.gw.call('upload_file', args, 20000, { fragments: true });
  assert.deepEqual(r, { ok: true, data: { content: [{ type: 'text', text: 'upload_file done' }] } });
  assert.deepEqual(got[0].args, args);
  // Without fragments allowed, the same is refused before anything is sent; the connection is fine.
  await assert.rejects(g.gw.call('upload_file', args, 2000), (e) => e.code === 'too_large');
  assert.equal((await g.gw.call('list_tabs', {}, 2000)).ok, true);
  // A second big upload works too (counters stayed in step).
  assert.equal((await g.gw.call('upload_file', args, 20000, { fragments: true })).ok, true);
  ext.stop();
});

/** A TCP relay that passes server → extension bytes at `rate` bytes/s, with backpressure (like a real proxy). */
async function slowProxy(targetPort, rate) {
  const sockets = new Set();
  const server = createServer((client) => {
    const upstream = connect(targetPort, '127.0.0.1');
    for (const s of [client, upstream]) { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); }
    client.on('data', (d) => upstream.write(d));
    const queue = [];
    let queued = 0;
    const tick = setInterval(() => {
      let budget = rate / 50;
      while (budget > 0 && queue.length) {
        const b = queue[0];
        const n = Math.min(b.length, budget);
        client.write(b.subarray(0, n));
        if (n === b.length) queue.shift(); else queue[0] = b.subarray(n);
        queued -= n;
        budget -= n;
      }
      if (queued < 64 * 1024) upstream.resume();
    }, 20);
    upstream.on('data', (d) => {
      queue.push(d);
      queued += d.length;
      if (queued >= 64 * 1024) upstream.pause();
    });
    client.on('close', () => { clearInterval(tick); upstream.destroy(); });
    upstream.on('close', () => { clearInterval(tick); client.destroy(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close() { for (const s of sockets) s.destroy(); server.close(); } };
}

test('a slow transfer: the heartbeat keeps the connection, other calls wait for the fragments', async (t) => {
  const g = await startGateway();
  const proxy = await slowProxy(g.port, 3 * MiB);
  t.after(() => { proxy.close(); g.gw.close(); });
  const order = [];
  const ext = makeExtension({
    url: `ws://127.0.0.1:${proxy.port}/cctether`, key: g.key,
    // A pong may wait behind a whole fragment, and much more in buffers on the way.
    options: { heartbeatMs: 200, pongTimeoutMs: 700 },
    onCall: async (tool) => { order.push(tool); return { ok: true, data: { content: [{ type: 'text', text: tool }] } }; },
  });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  const before = ext.statuses.length;
  const t0 = Date.now();
  const up = g.gw.call('upload_file', { files: [{ name: 'a.bin', type: '', data: 'A'.repeat(8 * MiB) }] }, 30000, { fragments: true });
  await sleep(300);
  const other = g.gw.call('list_tabs', {}, 30000);
  assert.equal((await up).ok, true);
  assert.equal((await other).ok, true);
  const took = Date.now() - t0;
  assert.ok(took > 1500, `the transfer took ${took} ms: too fast to test anything`);
  assert.deepEqual(order, ['upload_file', 'list_tabs'], 'the other call came after the fragments');
  assert.ok(ext.statuses.slice(before).every((s) => s.conn === 'connected'), `the connection dropped: ${JSON.stringify(ext.statuses.slice(before).map((s) => s.conn))}`);
  ext.stop();
});

test('the server gives up on a transfer that takes too long, and disconnects', async (t) => {
  const g = await startGateway();
  const proxy = await slowProxy(g.port, 4 * MiB);
  const ext = makeExtension({ url: `ws://127.0.0.1:${proxy.port}/cctether`, key: g.key });
  t.after(() => { ext.stop(); proxy.close(); g.gw.close(); });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  await assert.rejects(g.gw.call('upload_file', { data: 'A'.repeat(24 * MiB) }, 300, { fragments: true }),
    (e) => e.code === 'send_timeout' && /Nothing was run/.test(e.message));
  assert.equal(g.gw.status().connected, false, 'the server dropped the connection at once');
  // The extension sees it once what was already on the way has drained, and comes back.
  await ext.waitFor((s) => s.conn !== 'connected', 15000);
  await ext.waitFor((s) => s.conn === 'connected', 15000);
  assert.equal((await g.gw.call('list_tabs', {}, 5000)).ok, true);
});

// ---- a fake server that breaks the rules ---------------------------------------------------

/** A server that does the real handshake, then lets the test send anything. */
async function fakeServer(t, key) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await once(wss, 'listening');
  t.after(() => wss.close());
  let resolveConn;
  const conn = new Promise((r) => { resolveConn = r; });
  wss.on('connection', (ws) => {
    let cn;
    let sn;
    ws.on('message', (d, isBinary) => {
      if (isBinary) return; // pings, info: not needed here
      const m = JSON.parse(d.toString());
      if (m.t === 'hello') {
        cn = fromB64u(m.cn, 32);
        sn = randomBytes(32);
        ws.send(JSON.stringify({ t: 'challenge', proto: PROTO, sn: b64u(sn), sp: b64u(proof(key, LABEL_SERVER, cn, sn)) }));
      } else if (m.t === 'auth') {
        const { c2s, s2c } = deriveSessionKeys(key, cn, sn);
        const cipher = new SessionCipher(s2c, c2s);
        resolveConn({ ws, send: (obj) => ws.send(cipher.seal(obj)), raw: (b) => ws.send(b) });
      }
    });
  });
  return { url: `ws://127.0.0.1:${wss.address().port}/cctether`, conn };
}

const callText = (tool = 'upload_file') => JSON.stringify({ t: 'call', id: 1, tool, args: { files: [], tab: 1, origin: 'https://example.com' } });

async function expectBroken(t, steps, { welcome = true } = {}) {
  const key = randomBytes(32);
  const srv = await fakeServer(t, key);
  let called = false;
  const ext = makeExtension({ url: srv.url, key, onCall: async () => { called = true; return { ok: true, data: {} }; } });
  ext.start();
  const c = await srv.conn;
  if (welcome) {
    c.send({ t: 'welcome', server: '9.9.9' });
    await ext.waitFor((s) => s.conn === 'connected');
  }
  await steps(c);
  const st = await ext.waitFor((s) => s.conn === 'disconnected', 5000);
  assert.equal(st.error.code, 'protocol_error');
  await sleep(50);
  assert.equal(called, false, 'nothing was run');
  ext.stop();
}

test('the extension takes only well-formed fragment sequences', async (t) => {
  const text = callText();
  const half = Math.floor(text.length / 2);
  const [a, b] = [text.slice(0, half), text.slice(half)];

  // A well-formed one with a pong in between works.
  {
    const key = randomBytes(32);
    const srv = await fakeServer(t, key);
    const calls = [];
    const ext = makeExtension({ url: srv.url, key, onCall: async (tool, args) => { calls.push({ tool, args }); return { ok: true, data: {} }; } });
    ext.start();
    const c = await srv.conn;
    c.send({ t: 'welcome', server: '9.9.9' });
    await ext.waitFor((s) => s.conn === 'connected');
    c.send({ t: 'frag', i: 0, n: 2, s: a });
    c.send({ t: 'pong' });
    c.send({ t: 'frag', i: 1, n: 2, s: b });
    await sleep(200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'upload_file');
    assert.equal(ext.status.conn, 'connected');
    ext.stop();
  }

  await t.test('not starting at 0', () => expectBroken(t, (c) => c.send({ t: 'frag', i: 1, n: 2, s: b })));
  await t.test('a repeated fragment', () => expectBroken(t, (c) => { c.send({ t: 'frag', i: 0, n: 2, s: a }); c.send({ t: 'frag', i: 0, n: 2, s: a }); }));
  await t.test('a missing fragment', () => expectBroken(t, (c) => { c.send({ t: 'frag', i: 0, n: 3, s: a }); c.send({ t: 'frag', i: 2, n: 3, s: b }); }));
  await t.test('the count changing', () => expectBroken(t, (c) => { c.send({ t: 'frag', i: 0, n: 3, s: a }); c.send({ t: 'frag', i: 1, n: 2, s: b }); }));
  await t.test('another message in between', () => expectBroken(t, (c) => {
    c.send({ t: 'frag', i: 0, n: 2, s: a });
    c.send({ t: 'call', id: 2, tool: 'list_tabs', args: {} });
    c.send({ t: 'frag', i: 1, n: 2, s: b });
  }));
  await t.test('too many fragments', () => expectBroken(t, (c) => c.send({ t: 'frag', i: 0, n: 65, s: a })));
  await t.test('a single fragment', () => expectBroken(t, (c) => c.send({ t: 'frag', i: 0, n: 1, s: text })));
  await t.test('bad fields', () => expectBroken(t, (c) => c.send({ t: 'frag', i: '0', n: 2, s: a })));
  await t.test('a fragmented message that is not an upload_file call', () => expectBroken(t, (c) => {
    const other = callText('evaluate');
    c.send({ t: 'frag', i: 0, n: 2, s: other.slice(0, 10) });
    c.send({ t: 'frag', i: 1, n: 2, s: other.slice(10) });
  }));
  await t.test('more than 32 MiB of fragments', () => expectBroken(t, async (c) => {
    const piece = 'A'.repeat(MiB - 100);
    for (let i = 0; i < 34; i++) {
      c.send({ t: 'frag', i, n: 40, s: piece });
      await sleep(5);
    }
  }));
  await t.test('a frame over 1 MiB', () => expectBroken(t, (c) => c.raw(randomBytes(MiB + 1))));
  await t.test('a fragment before the handshake is done', () => expectBroken(t, (c) => c.send({ t: 'frag', i: 0, n: 2, s: a }), { welcome: false }));
});

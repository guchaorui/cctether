// The extension's real connection code (extension/background/connection.js) against the real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { startGateway, makeExtension, rawClient, sleep, ORIGIN, blackholeProxy } from './helpers.js';
import { FailureLimiter } from '../src/ratelimit.js';
import { PROTO, LABEL_CLIENT, LABEL_SERVER, b64u, fromB64u, proof, deriveSessionKeys, SessionCipher } from '../src/protocol.js';

test('handshake, info, tool call round trip', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const ext = makeExtension({ url: g.url, key: g.key });
  ext.start();
  const st = await ext.waitFor((s) => s.conn === 'connected');
  assert.equal(st.serverVersion, '9.9.9');
  assert.equal(st.server, `127.0.0.1:${g.port}`);
  await sleep(50);
  assert.equal(g.gw.status().connected, true);
  assert.deepEqual(g.gw.status().info, { extension: '0.1.0', browser: 'TestBrowser 1', platform: 'test' });
  const r = await g.gw.call('find', { selector: 'a' }, 2000);
  assert.deepEqual(r, { ok: true, data: { content: [{ type: 'text', text: 'find:{"selector":"a"}' }] } });
  ext.stop();
});

test('tool errors come back as structured errors', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const ext = makeExtension({ url: g.url, key: g.key, onCall: async () => ({ ok: false, error: { code: 'not_shared', message: 'nope' } }) });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  assert.deepEqual(await g.gw.call('click', {}, 2000), { ok: false, error: { code: 'not_shared', message: 'nope' } });
  ext.stop();
});

test('large results arrive intact through fragments', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  // Mixed content: base64-ish ASCII, multi-byte characters, characters JSON must escape, surrogate pairs.
  const big = 'A'.repeat(3_000_000) + '中文"\\\n\u0001😀'.repeat(50_000);
  const ext = makeExtension({ url: g.url, key: g.key, onCall: async () => ({ ok: true, data: { content: [{ type: 'text', text: big }] } }) });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  const r = await g.gw.call('screenshot', {}, 10000);
  assert.equal(r.data.content[0].text, big);
  // The connection still works afterwards.
  assert.equal((await g.gw.call('screenshot', {}, 10000)).ok, true);
  ext.stop();
});

test('wrong key: the extension refuses the server (server_auth_failed) and does not retry soon', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const ext = makeExtension({ url: g.url, key: randomBytes(32) });
  ext.start();
  const st = await ext.waitFor((s) => s.conn === 'disconnected');
  assert.equal(st.error.code, 'server_auth_failed');
  assert.ok(st.retryAt - Date.now() > 4 * 60_000, 'slow retry for auth errors');
  assert.equal(g.gw.status().connected, false);
  ext.stop();
});

test('an impostor server cannot get the extension to run anything', async (t) => {
  // A fake server that does not know the key: it answers the hello with a made-up proof.
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  t.after(() => wss.close());
  let gotAuth = false;
  wss.on('connection', (ws) => {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'hello') ws.send(JSON.stringify({ t: 'challenge', proto: PROTO, sn: b64u(randomBytes(32)), sp: b64u(randomBytes(32)) }));
      if (m.t === 'auth') gotAuth = true;
    });
  });
  let called = false;
  const ext = makeExtension({ url: `ws://127.0.0.1:${wss.address().port}/cctether`, key: randomBytes(32), onCall: async () => { called = true; return { ok: true, data: {} }; } });
  ext.start();
  const st = await ext.waitFor((s) => s.conn === 'disconnected');
  assert.equal(st.error.code, 'server_auth_failed');
  await sleep(100);
  assert.equal(gotAuth, false, 'the extension must not even send its proof');
  assert.equal(called, false);
  ext.stop();
});

test('a client with a forged proof is rejected, and repeated failures get the IP blocked', async (t) => {
  const g = await startGateway({ limiter: new FailureLimiter({ maxFailures: 3 }) });
  t.after(() => g.gw.close());
  for (let i = 0; i < 3; i++) {
    const c = rawClient(g.url);
    await c.opened;
    c.send({ t: 'hello', proto: PROTO, cn: b64u(randomBytes(32)) });
    const ch = await c.next();
    assert.equal(ch.t, 'challenge');
    c.send({ t: 'auth', cp: b64u(randomBytes(32)) });
    assert.deepEqual(await c.next(), { t: 'error', code: 'auth_rejected' });
    assert.equal(await c.closed, 4401);
  }
  const c = rawClient(g.url);
  await c.opened;
  assert.deepEqual(await c.next(), { t: 'error', code: 'rate_limited' });
  // Even the right key is refused while blocked.
  const ext = makeExtension({ url: g.url, key: g.key });
  ext.start();
  const st = await ext.waitFor((s) => s.conn === 'disconnected');
  assert.equal(st.error.code, 'rate_limited');
  ext.stop();
});

test('replaying a recorded proof does not work', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  // Record a legitimate handshake.
  const cn = randomBytes(32);
  const c1 = rawClient(g.url);
  await c1.opened;
  c1.send({ t: 'hello', proto: PROTO, cn: b64u(cn) });
  const ch1 = await c1.next();
  const cp1 = proof(g.key, LABEL_CLIENT, cn, fromB64u(ch1.sn, 32));
  c1.send({ t: 'auth', cp: b64u(cp1) });
  await c1.next(); // welcome (binary)
  c1.ws.close();
  // Replay the same hello and proof on a new connection.
  const c2 = rawClient(g.url);
  await c2.opened;
  c2.send({ t: 'hello', proto: PROTO, cn: b64u(cn) });
  const ch2 = await c2.next();
  assert.notEqual(ch2.sn, ch1.sn, 'the server picks a fresh nonce');
  c2.send({ t: 'auth', cp: b64u(cp1) });
  assert.deepEqual(await c2.next(), { t: 'error', code: 'auth_rejected' });
});

test('the server proof cannot be reflected as a client proof', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const c = rawClient(g.url);
  await c.opened;
  c.send({ t: 'hello', proto: PROTO, cn: b64u(randomBytes(32)) });
  const ch = await c.next();
  c.send({ t: 'auth', cp: ch.sp });
  assert.deepEqual(await c.next(), { t: 'error', code: 'auth_rejected' });
});

test('tampered, replayed and plaintext frames after the handshake kill the connection', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  async function authed() {
    const cn = randomBytes(32);
    const c = rawClient(g.url);
    await c.opened;
    c.send({ t: 'hello', proto: PROTO, cn: b64u(cn) });
    const sn = fromB64u((await c.next()).sn, 32);
    c.send({ t: 'auth', cp: b64u(proof(g.key, LABEL_CLIENT, cn, sn)) });
    const { c2s, s2c } = deriveSessionKeys(g.key, cn, sn);
    const cipher = new SessionCipher(c2s, s2c);
    const welcome = cipher.open(await c.next());
    assert.equal(welcome.t, 'welcome');
    return { c, cipher };
  }
  // Tampered.
  {
    const { c, cipher } = await authed();
    const f = cipher.seal({ t: 'ping' });
    f[0] ^= 1;
    c.send(f);
    assert.equal(await c.closed, 4400);
  }
  // Replayed.
  {
    const { c, cipher } = await authed();
    const f = cipher.seal({ t: 'ping' });
    c.send(f);
    const pong = cipher.open(await c.next());
    assert.equal(pong.t, 'pong');
    c.send(f);
    assert.equal(await c.closed, 4400);
  }
  // Plaintext.
  {
    const { c } = await authed();
    c.send({ t: 'ping' });
    assert.equal(await c.closed, 4400);
  }
});

test('Origin is checked: other extensions and web pages are refused', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  for (const origin of ['chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'https://evil.example', 'null']) {
    const c = rawClient(g.url, { origin });
    await c.opened;
    assert.deepEqual(await c.next(), { t: 'error', code: 'origin_rejected' });
    assert.equal(await c.closed, 4403);
  }
  // No Origin header at all.
  const c = rawClient(g.url, { origin: '' });
  await c.opened;
  assert.deepEqual(await c.next(), { t: 'error', code: 'origin_rejected' });
  // The extension sees a clear error.
  const ext = makeExtension({ url: g.url, key: g.key, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
  ext.start();
  assert.equal((await ext.waitFor((s) => s.conn === 'disconnected')).error.code, 'origin_rejected');
  ext.stop();
});

test('wrong path gets 404', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const c = rawClient(g.url.replace('/cctether', '/other'));
  await assert.rejects(c.opened, (e) => e.status === 404);
  const res = await fetch(`http://127.0.0.1:${g.port}/cctether`);
  assert.equal(res.status, 404);
});

test('protocol version mismatch tells which side to update', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  for (const [proto, code] of [[PROTO + 1, 'update_server'], [0, 'update_extension'], ['x', 'update_extension']]) {
    const c = rawClient(g.url);
    await c.opened;
    c.send({ t: 'hello', proto, cn: b64u(randomBytes(32)) });
    const m = await c.next();
    assert.equal(m.code, code);
    assert.equal(await c.closed, 4426);
  }
});

test('slow handshakes are cut off; malformed hellos are refused', async (t) => {
  const g = await startGateway({ handshakeTimeoutMs: 300 });
  t.after(() => g.gw.close());
  const slow = rawClient(g.url);
  await slow.opened;
  assert.equal(await slow.closed, 4408);
  for (const bad of [{ t: 'hello', proto: PROTO, cn: 'short' }, { t: 'auth', cp: 'x' }, 'not json', { t: 'hello', proto: PROTO, cn: b64u(randomBytes(32)) + 'A' }]) {
    const c = rawClient(g.url);
    await c.opened;
    c.send(bad);
    assert.equal(await c.closed, 4400);
  }
});

test('oversized frames before authentication are refused', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const c = rawClient(g.url);
  await c.opened;
  c.send('x'.repeat(5000));
  assert.equal(await c.closed, 4400);
  const c2 = rawClient(g.url);
  await c2.opened;
  c2.send(Buffer.alloc(2 * 1024 * 1024));
  const code = await c2.closed;
  assert.ok(code === 1009 || code === 1006, `closed with ${code}`);
});

test('too many unauthenticated connections at once are refused', async (t) => {
  const g = await startGateway({ handshakeTimeoutMs: 3000 });
  t.after(() => g.gw.close());
  const idle = [];
  for (let i = 0; i < 16; i++) {
    const c = rawClient(g.url);
    await c.opened;
    idle.push(c);
  }
  const extra = rawClient(g.url);
  await assert.rejects(extra.opened, (e) => e.status === 503);
  for (const c of idle) c.ws.terminate();
});

test('a second browser replaces the first, which is told why and does not retry', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const a = makeExtension({ url: g.url, key: g.key });
  a.start();
  await a.waitFor((s) => s.conn === 'connected');
  const b = makeExtension({ url: g.url, key: g.key, onCall: async () => ({ ok: true, data: { content: [{ type: 'text', text: 'from b' }] } }) });
  b.start();
  await b.waitFor((s) => s.conn === 'connected');
  const st = await a.waitFor((s) => s.conn === 'replaced');
  assert.equal(st.retryAt, null);
  assert.equal((await g.gw.call('list_tabs', {}, 2000)).data.content[0].text, 'from b');
  await sleep(1500);
  assert.equal(a.status.conn, 'replaced', 'still replaced, no automatic retry');
  a.stop();
  b.stop();
});

test('rotating the key disconnects the browser; the old code no longer works', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const ext = makeExtension({ url: g.url, key: g.key });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  g.gw.setKey(randomBytes(32));
  const st = await ext.waitFor((s) => s.conn === 'disconnected' && s.error?.code === 'server_auth_failed', 5000);
  assert.equal(st.error.code, 'server_auth_failed');
  ext.stop();
});

test('server restart: the extension reconnects by itself', async (t) => {
  const g = await startGateway();
  const ext = makeExtension({ url: g.url, key: g.key });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  await g.gw.close();
  await ext.waitFor((s) => s.conn === 'disconnected');
  // Same port, same key.
  const { Gateway } = await import('../src/gateway.js');
  const gw2 = new Gateway({ key: g.key, extensionIds: ['nfebjhhcnoilmfjacolkofphfekkjioh'], version: '9.9.10' });
  await gw2.listen(g.port);
  t.after(() => gw2.close());
  const st = await ext.waitFor((s) => s.conn === 'connected' && s.serverVersion === '9.9.10', 8000);
  assert.equal(st.error, null);
  ext.stop();
});

test('calls fail cleanly when the browser goes away or does not answer', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  await assert.rejects(g.gw.call('list_tabs', {}, 1000), (e) => e.code === 'no_browser');
  let release;
  const ext = makeExtension({ url: g.url, key: g.key, onCall: () => new Promise((r) => { release = r; }) });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  await assert.rejects(g.gw.call('list_tabs', {}, 200), (e) => e.code === 'timeout');
  const p = g.gw.call('list_tabs', {}, 5000);
  await sleep(50);
  ext.stop();
  await assert.rejects(p, (e) => e.code === 'disconnected');
  release?.({ ok: true, data: {} });
});

test('the server side of the protocol matches the WebCrypto side byte for byte', async () => {
  const { importSharedKey, clientProof, verifyServerProof, createSessionCipher } = await import('../../extension/background/crypto.js');
  const key = randomBytes(32);
  const cn = randomBytes(32);
  const sn = randomBytes(32);
  const keys = await importSharedKey(new Uint8Array(key));
  assert.deepEqual(Buffer.from(await clientProof(keys, cn, sn)), proof(key, LABEL_CLIENT, cn, sn));
  assert.equal(await verifyServerProof(keys, cn, sn, new Uint8Array(proof(key, LABEL_SERVER, cn, sn))), true);
  assert.equal(await verifyServerProof(keys, cn, sn, new Uint8Array(proof(key, LABEL_CLIENT, cn, sn))), false);
  const ext = await createSessionCipher(keys, cn, sn);
  const { c2s, s2c } = deriveSessionKeys(key, cn, sn);
  const srv = new SessionCipher(s2c, c2s);
  for (let i = 0; i < 3; i++) {
    const frame = Buffer.from(await ext.seal(JSON.stringify({ t: 'x', i })));
    assert.deepEqual(srv.open(frame), { t: 'x', i });
    assert.deepEqual(await ext.open(srv.seal({ t: 'y', i })), { t: 'y', i });
  }
  // Out-of-order frames fail.
  const f1 = Buffer.from(await ext.seal('{"t":"a"}'));
  const f2 = Buffer.from(await ext.seal('{"t":"b"}'));
  assert.throws(() => srv.open(f2));
  void f1;
  // Sanity: HMAC label really is part of the proof.
  assert.notDeepEqual(proof(key, LABEL_CLIENT, cn, sn), createHmac('sha256', key).update(cn).update(sn).digest());
});

test('a network path that silently stops working is noticed by the heartbeat', async (t) => {
  const g = await startGateway();
  const proxy = await blackholeProxy(g.port);
  t.after(() => { proxy.close(); g.gw.close(); });
  const ext = makeExtension({
    url: `ws://127.0.0.1:${proxy.port}/cctether`, key: g.key,
    options: { heartbeatMs: 200, pongTimeoutMs: 300 },
  });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  await sleep(700); // pings are answered while the path works
  assert.equal(ext.status.conn, 'connected');
  proxy.kill(); // no FIN, no RST: bytes just stop arriving
  const t0 = Date.now();
  const st = await ext.waitFor((s) => s.conn === 'disconnected', 3000);
  assert.equal(st.error.code, 'timeout');
  assert.ok(Date.now() - t0 < 1500, `noticed after ${Date.now() - t0} ms`);
  ext.stop();
});

test('going offline is shown at once; the connection comes back with the network', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  let online = true;
  const ext = makeExtension({ url: g.url, key: g.key, options: { isOnline: () => online } });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  online = false;
  ext.conn.networkLost();
  assert.equal(ext.status.conn, 'disconnected');
  assert.deepEqual(ext.status.error, { code: 'offline' });
  assert.equal(ext.status.retryAt, null, 'no retry timer while offline');
  // A periodic check while still offline does nothing.
  ext.conn.tick();
  await sleep(200);
  assert.equal(ext.status.error.code, 'offline');
  // Network back.
  online = true;
  ext.conn.networkBack();
  await ext.waitFor((s) => s.conn === 'connected');
  // A failed attempt while the computer is offline is also reported as offline.
  online = false;
  ext.conn.reconnectNow();
  await g.gw.close();
  const st = await ext.waitFor((s) => s.conn === 'disconnected');
  assert.equal(st.error.code, 'offline');
  ext.stop();
});

test('the periodic check reconnects if the online event was missed', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  let online = true;
  const ext = makeExtension({ url: g.url, key: g.key, options: { isOnline: () => online } });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  online = false;
  ext.conn.networkLost();
  online = true;
  ext.conn.tick();
  await ext.waitFor((s) => s.conn === 'connected');
  ext.stop();
});

test('the network coming back does not take over from another browser', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const a = makeExtension({ url: g.url, key: g.key });
  a.start();
  await a.waitFor((s) => s.conn === 'connected');
  const b = makeExtension({ url: g.url, key: g.key });
  b.start();
  await b.waitFor((s) => s.conn === 'connected');
  await a.waitFor((s) => s.conn === 'replaced');
  a.conn.networkLost();
  a.conn.networkBack();
  a.conn.tick();
  await sleep(300);
  assert.equal(a.status.conn, 'replaced');
  assert.equal(b.status.conn, 'connected');
  a.stop();
  b.stop();
});

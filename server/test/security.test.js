// Security review (SPEC §6.3): adversarial tests against the extension entrance (gateway),
// the control entrance and the config/socket files. Tests for attacks that are correctly
// blocked stay as regressions; tests marked { todo: 'SECURITY: ...' } demonstrate a real gap
// without turning the suite red.
//
// Run: cd server && node --test test/*.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTO, LABEL_CLIENT, b64u, fromB64u, proof } from '../src/protocol.js';
import { startGateway, rawClient, makeExtension } from './helpers.js';
import { startControl, AlreadyRunningError } from '../src/control.js';
import { initConfig, paths } from '../src/config.js';
import { keyFingerprint, encodePairingCode } from '../src/pairing.js';

// --- Threat 1: internet attacker reaching the extension entrance -------------------------------

// The per-IP failure limiter (SPEC §6.2) must not trust a client-supplied X-Forwarded-For unless a
// local reverse proxy is configured (trustProxy): otherwise a local process (threat 3) could send a
// different forged address on every attempt and never trip the block, or get an innocent address
// blocked. (Found in the phase-1 security review; fixed by the trustProxy setting.)
test('forging X-Forwarded-For does not evade the failure limiter when no proxy is trusted', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  for (let i = 0; i < 6; i++) {
    const c = rawClient(g.url, { headers: { 'x-forwarded-for': `203.0.113.${i}` } });
    await c.opened;
    c.send({ t: 'hello', proto: PROTO, cn: b64u(randomBytes(32)) });
    const first = await c.next();
    if (first.t === 'error') { assert.equal(first.code, 'rate_limited'); break; }
    c.send({ t: 'auth', cp: b64u(randomBytes(32)) }); // wrong proof
    await c.closed;
  }
  const c = rawClient(g.url, { headers: { 'x-forwarded-for': '203.0.113.250' } });
  await c.opened;
  c.send({ t: 'hello', proto: PROTO, cn: b64u(randomBytes(32)) });
  assert.deepEqual(await c.next(), { t: 'error', code: 'rate_limited' });
});

test('behind a trusted local proxy, failures are counted per forwarded address', async (t) => {
  const g = await startGateway();
  g.gw.trustProxy = true;
  t.after(() => g.gw.close());
  const fail = async (ip) => {
    const c = rawClient(g.url, { headers: { 'x-forwarded-for': ip } });
    await c.opened;
    c.send({ t: 'hello', proto: PROTO, cn: b64u(randomBytes(32)) });
    const m = await c.next();
    if (m.t === 'error') return m.code;
    c.send({ t: 'auth', cp: b64u(randomBytes(32)) });
    await c.closed;
    return 'failed';
  };
  for (let i = 0; i < 5; i++) assert.equal(await fail('198.51.100.1'), 'failed');
  assert.equal(await fail('198.51.100.1'), 'rate_limited');
  // Someone else (the owner) behind the same proxy is not locked out.
  const ext = makeExtension({ url: g.url, key: g.key, headers: { 'x-forwarded-for': '198.51.100.2' } });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  ext.stop();
});

// Control: the limiter does work when the attacker cannot rotate the key it is bucketed by.
test('the failure limiter blocks repeated failures from one source', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  for (let i = 0; i < 6; i++) {
    const c = rawClient(g.url);
    await c.opened;
    c.send({ t: 'hello', proto: PROTO, cn: b64u(randomBytes(32)) });
    await c.next();
    c.send({ t: 'auth', cp: b64u(randomBytes(32)) });
    await c.closed;
  }
  const c = rawClient(g.url);
  await c.opened;
  c.send({ t: 'hello', proto: PROTO, cn: b64u(randomBytes(32)) });
  assert.deepEqual(await c.next(), { t: 'error', code: 'rate_limited' });
});

// A binary frame (a would-be fragment) or a frag message before the handshake completes is
// refused: fragment abuse is impossible without first authenticating.
test('fragment / binary / frag-shaped frames before authentication are refused', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  // Binary frame in the very first position.
  {
    const c = rawClient(g.url);
    await c.opened;
    c.send(Buffer.from([1, 2, 3, 4]));
    assert.equal(await c.closed, 4400);
  }
  // A frag-shaped text message where a hello is expected.
  {
    const c = rawClient(g.url);
    await c.opened;
    c.send({ t: 'frag', s: 'x'.repeat(100), end: true });
    assert.equal(await c.closed, 4400);
  }
  // A frag-shaped message after hello but before auth (still a text frame, still rejected).
  {
    const c = rawClient(g.url);
    await c.opened;
    c.send({ t: 'hello', proto: PROTO, cn: b64u(randomBytes(32)) });
    await c.next();
    c.send({ t: 'frag', s: 'x'.repeat(100), end: true });
    assert.equal(await c.closed, 4400);
  }
});

// --- Threat 6: leaked connection code / key rotation -------------------------------------------

// rotate (cctether rotate / setKey) must invalidate a handshake already in flight, even if the
// client finishes with a correct proof for the OLD key.
test('rotating the key mid-handshake rejects a client that completes with the old key', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const cn = randomBytes(32);
  const c = rawClient(g.url);
  await c.opened;
  c.send({ t: 'hello', proto: PROTO, cn: b64u(cn) });
  const ch = await c.next();
  const sn = fromB64u(ch.sn, 32);
  g.gw.setKey(randomBytes(32)); // operator rotates while this client is mid-handshake
  c.send({ t: 'auth', cp: b64u(proof(g.key, LABEL_CLIENT, cn, sn)) }); // valid proof for the OLD key
  assert.equal(await c.closed, 4410); // keyChanged — not adopted
  assert.equal(g.gw.browser, null);
});

// rotate disconnects the currently connected browser at once.
test('rotating the key disconnects the connected browser immediately', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const ext = makeExtension({ url: g.url, key: g.key });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  assert.ok(g.gw.browser);
  g.gw.setKey(randomBytes(32));
  await ext.waitFor((s) => s.conn !== 'connected');
  assert.equal(g.gw.browser, null);
  ext.stop();
});

// The key must never appear in logs; the fingerprint identifies it without revealing it.
test('the key never appears in logs and status, and the fingerprint is not the key', async (t) => {
  const g = await startGateway();
  t.after(() => g.gw.close());
  const keyB64 = Buffer.from(g.key).toString('base64url');

  // A failed attempt and a successful connection both produce log lines.
  const bad = rawClient(g.url);
  await bad.opened;
  bad.send({ t: 'hello', proto: PROTO, cn: b64u(randomBytes(32)) });
  await bad.next();
  bad.send({ t: 'auth', cp: b64u(randomBytes(32)) });
  await bad.closed;

  const ext = makeExtension({ url: g.url, key: g.key });
  ext.start();
  await ext.waitFor((s) => s.conn === 'connected');
  ext.stop();

  for (const line of g.logs) assert.ok(!line.includes(keyB64), `log line leaked the key: ${line}`);

  const fp = keyFingerprint(g.key);
  assert.match(fp, /^[0-9a-f]{8}$/);
  assert.ok(!keyB64.includes(fp), 'fingerprint should be a hash prefix, not a slice of the key');
  assert.ok(!('key' in g.gw.status()), 'gateway.status() must not expose the key');

  // The connection code carries the key (it is the credential), which is exactly why it must
  // never reach logs or status: decoding the code recovers the exact key.
  const code = encodePairingCode('ws://127.0.0.1:1/cctether', g.key);
  const decoded = JSON.parse(Buffer.from(code.slice('cctether1:'.length), 'base64url').toString());
  assert.equal(decoded.k, keyB64);
  for (const line of g.logs) assert.ok(!line.includes(code), 'log line leaked the connection code');
});

// --- Threat 3: other local users / processes on the server -------------------------------------

// The control socket, config dir and config.json are private; a stale socket from a crashed run
// is cleaned up and reused, but a live one is refused (no silent takeover). The config dir is
// mode 700, so even a momentarily group/other-accessible socket can't be reached by other users.
test('control socket and config files are private; stale socket reused, live one refused', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cctether-sec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { created } = initConfig(dir);
  assert.ok(created);
  const P = paths(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700, 'config dir must be 700');
  assert.equal(statSync(P.config).mode & 0o777, 0o600, 'config.json must be 600');

  const ctl = await startControl({ socketPath: P.socket, onMcp() {}, onAdmin: async () => ({ ok: true }) });
  t.after(() => ctl.close());
  assert.equal(statSync(P.socket).mode & 0o777, 0o600, 'control socket must be 600');

  // A second service refuses to start while the first holds the socket.
  await assert.rejects(
    startControl({ socketPath: P.socket, onMcp() {}, onAdmin: async () => ({}) }),
    (e) => e instanceof AlreadyRunningError,
  );
  await ctl.close();

  // A leftover (stale, nobody listening) socket file is cleaned up and reused.
  writeFileSync(P.socket, '');
  const ctl2 = await startControl({ socketPath: P.socket, onMcp() {}, onAdmin: async () => ({ ok: true }) });
  t.after(() => ctl2.close());
  assert.equal(statSync(P.socket).mode & 0o777, 0o600);
});

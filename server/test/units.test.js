import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, statSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FailureLimiter, clientIp } from '../src/ratelimit.js';
import { validate } from '../src/schema.js';
import { encodePairingCode, decodePairingCode, keyFingerprint } from '../src/pairing.js';
import { initConfig, loadConfig, saveConfig, configDir, isValidServerUrl, serverUrl, trustProxy, socketPath, ConfigError, DEFAULT_EXTENSION_IDS } from '../src/config.js';
import { TOOLS, mcpToolList } from '../src/tools.js';
import { parsePairingCode, keyFingerprint as extFingerprint, checkServerUrl, displayServer } from '../../extension/shared/pairing.js';

test('failure limiter blocks after N failures within the window, then forgets', () => {
  let now = 1_000_000;
  const l = new FailureLimiter({ maxFailures: 3, windowMs: 60_000, blockMs: 300_000, now: () => now });
  assert.equal(l.fail('a'), false);
  assert.equal(l.fail('a'), false);
  assert.equal(l.isBlocked('a'), false);
  assert.equal(l.fail('a'), true);
  assert.equal(l.isBlocked('a'), true);
  assert.equal(l.isBlocked('b'), false);
  now += 299_000;
  assert.equal(l.isBlocked('a'), true);
  now += 2_000;
  assert.equal(l.isBlocked('a'), false);
  // Failures spread out over more than the window don't add up.
  l.fail('c'); now += 61_000; l.fail('c'); now += 61_000;
  assert.equal(l.fail('c'), false);
});

test('failure limiter memory is bounded', () => {
  const l = new FailureLimiter({ maxEntries: 100 });
  for (let i = 0; i < 1000; i++) l.fail(`10.0.${i >> 8}.${i & 255}`);
  // No exception, and recent entries are still tracked.
  l.fail('10.0.3.231');
  l.fail('10.0.3.231');
  l.fail('10.0.3.231');
  l.fail('10.0.3.231');
  assert.equal(l.isBlocked('10.0.3.231'), true);
});

test('clientIp uses X-Forwarded-For only when told a local proxy is in front', () => {
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  const trust = { trustProxy: true };
  assert.equal(clientIp(req('203.0.113.9', '1.2.3.4'), trust), '203.0.113.9');
  assert.equal(clientIp(req('127.0.0.1', '6.6.6.6, 198.51.100.7'), trust), '198.51.100.7');
  assert.equal(clientIp(req('::1', '198.51.100.7'), trust), '198.51.100.7');
  assert.equal(clientIp(req('127.0.0.1'), trust), '127.0.0.1');
  assert.equal(clientIp(req('::ffff:127.0.0.1', ' '), trust), '::ffff:127.0.0.1');
  // Default: the header is ignored.
  assert.equal(clientIp(req('127.0.0.1', '198.51.100.7')), '127.0.0.1');
});

test('trustProxy follows the public address unless set explicitly', () => {
  const base = { publicUrl: null, trustProxySetting: null };
  assert.equal(trustProxy(base), false);
  assert.equal(trustProxy({ ...base, publicUrl: 'wss://browser.example.com/cctether' }), true);
  assert.equal(trustProxy({ ...base, publicUrl: 'ws://127.0.0.1:27182/cctether' }), false);
  assert.equal(trustProxy({ ...base, publicUrl: 'wss://localhost:9443/cctether' }), false);
  assert.equal(trustProxy({ publicUrl: 'wss://browser.example.com/cctether', trustProxySetting: false }), false);
  assert.equal(trustProxy({ publicUrl: null, trustProxySetting: true }), true);
});

test('control socket path falls back to the private runtime dir when the config path is too long', () => {
  const long = join(mkdtempSync(join(tmpdir(), 'cct-')), 'x'.repeat(120));
  const rt = mkdtempSync(join(tmpdir(), 'rt-'));
  chmodSync(rt, 0o700);
  const p = socketPath(long, { XDG_RUNTIME_DIR: rt });
  assert.ok(p.startsWith(rt + '/cctether-') && p.endsWith('.sock'), p);
  assert.equal(socketPath(long, { XDG_RUNTIME_DIR: rt }), p, 'stable');
  // A runtime dir others can read is not used.
  chmodSync(rt, 0o755);
  assert.equal(socketPath(long, { XDG_RUNTIME_DIR: rt }), join(long, 'control.sock'));
  assert.equal(socketPath('/short', {}), '/short/control.sock');
});

test('schema validation', () => {
  const s = TOOLS.find((t) => t.name === 'click').inputSchema;
  assert.equal(validate(s, {}), null);
  assert.equal(validate(s, { ref: 3, button: 'left', modifiers: ['Shift'] }), null);
  assert.match(validate(s, { ref: 0 }), /ref must be >= 1/);
  assert.match(validate(s, { ref: 1.5 }), /ref must be integer/);
  assert.match(validate(s, { button: 'top' }), /must be one of/);
  assert.match(validate(s, { modifiers: ['Hyper'] }), /modifiers\[0\]/);
  assert.match(validate(s, { bogus: 1 }), /not a known argument/);
  assert.match(validate(s, []), /must be object/);
  assert.match(validate(s, null), /must be object/);
  const sel = TOOLS.find((t) => t.name === 'select_option').inputSchema;
  assert.equal(validate(sel, { value: 'a' }), null);
  assert.equal(validate(sel, { value: ['a', 'b'] }), null);
  assert.match(validate(sel, { value: [1] }), /value\[0\] must be string/);
  assert.match(validate(sel, {}), /value is required/);
  const rel = TOOLS.find((t) => t.name === 'reload_extension').inputSchema;
  assert.match(validate(rel, { id: 'not-an-id' }), /wrong format/);
  assert.equal(validate(rel, { id: 'nfebjhhcnoilmfjacolkofphfekkjioh' }), null);
  const ev = TOOLS.find((t) => t.name === 'evaluate').inputSchema;
  assert.match(validate(ev, { expression: 'x'.repeat(200_001) }), /too long/);
  assert.match(validate(TOOLS.find((t) => t.name === 'scroll').inputSchema, { x: Infinity }), /finite/);
});

test('tool definitions are well-formed', () => {
  const names = new Set();
  for (const t of mcpToolList()) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(!names.has(t.name));
    names.add(t.name);
    assert.ok(t.description.length > 10 && t.description.length < 600, t.name);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean');
  }
  assert.equal(names.size, 20);
});

test('connection codes: server encodes, extension decodes', async () => {
  const key = randomBytes(32);
  const code = encodePairingCode('wss://browser.example.com/cctether', key);
  assert.ok(code.startsWith('cctether1:'));
  const p = parsePairingCode(`  ${code.slice(0, 20)}\n${code.slice(20)}  `); // pasted with line breaks
  assert.equal(p.ok, true);
  assert.equal(p.url, 'wss://browser.example.com/cctether');
  assert.deepEqual(Buffer.from(p.key), key);
  assert.equal(await extFingerprint(p.key), keyFingerprint(key));
  assert.deepEqual(decodePairingCode(code), { url: 'wss://browser.example.com/cctether', key });
});

test('connection codes: bad input is rejected; plain ws:// only for this computer', () => {
  const key = randomBytes(32);
  assert.deepEqual(parsePairingCode('hello'), { ok: false, error: 'invalid_code' });
  assert.deepEqual(parsePairingCode('cctether1:!!!'), { ok: false, error: 'invalid_code' });
  assert.deepEqual(parsePairingCode(encodePairingCode('wss://x.example', randomBytes(16))), { ok: false, error: 'invalid_code' });
  assert.deepEqual(parsePairingCode(encodePairingCode('ws://evil.example/cctether', key)), { ok: false, error: 'insecure_url' });
  assert.deepEqual(parsePairingCode(encodePairingCode('ws://10.0.0.5:27182/cctether', key)), { ok: false, error: 'insecure_url' });
  assert.deepEqual(parsePairingCode(encodePairingCode('https://x.example', key)), { ok: false, error: 'invalid_code' });
  assert.deepEqual(parsePairingCode(encodePairingCode('wss://user:pw@x.example', key)), { ok: false, error: 'invalid_code' });
  for (const u of ['ws://127.0.0.1:27182/cctether', 'ws://localhost:1/cctether', 'ws://[::1]:5/cctether', 'wss://a.example/cctether']) {
    assert.equal(parsePairingCode(encodePairingCode(u, key)).ok, true, u);
  }
  assert.equal(checkServerUrl('ws://127.0.0.1.evil.example/'), 'insecure');
  assert.equal(displayServer('wss://browser.example.com/cctether'), 'browser.example.com');
  assert.equal(displayServer('ws://127.0.0.1:27182/cctether'), '127.0.0.1:27182');
  assert.equal(displayServer('wss://h.example/custom'), 'h.example/custom');
});

test('server URL validation matches the extension', () => {
  for (const [u, ok] of [['wss://a.example/cctether', true], ['ws://127.0.0.1:1/cctether', true], ['ws://a.example/', false], ['http://a.example', false], ['wss://a.example/?x=1', false]]) {
    assert.equal(isValidServerUrl(u), ok, u);
  }
});

test('config: created with private permissions, round-trips, repairs loose permissions', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cct-')), 'cfg');
  const { cfg, created } = initConfig(dir);
  assert.equal(created, true);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const file = join(dir, 'config.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(cfg.port, 27182);
  assert.equal(serverUrl(cfg), 'ws://127.0.0.1:27182/cctether');
  assert.equal(initConfig(dir).created, false);
  cfg.publicUrl = 'wss://b.example/cctether';
  saveConfig(dir, cfg);
  chmodSync(file, 0o644);
  const again = loadConfig(dir);
  assert.equal(statSync(file).mode & 0o777, 0o600, 'loose permissions are fixed on load');
  assert.equal(again.publicUrl, 'wss://b.example/cctether');
  assert.deepEqual(again.key, cfg.key);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...raw, key: 'short' }));
  assert.throws(() => loadConfig(dir), ConfigError);
  writeFileSync(file, JSON.stringify({ ...raw, publicUrl: 'ws://remote.example/' }));
  assert.throws(() => loadConfig(dir), ConfigError);
});

test('config: cctether’s own extension IDs are always allowed; config.json only adds extra ones', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cct-')), 'cfg');
  const STORE = 'mbkadoolgknacadjkfjjajldmllbkdib';
  const SELF = 'nfebjhhcnoilmfjacolkofphfekkjioh';
  assert.deepEqual(DEFAULT_EXTENSION_IDS, [SELF, STORE]);
  // A config file written by 0.3.0 and earlier lists the then-default ID explicitly.
  const { cfg } = initConfig(dir);
  const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...raw, extensionIds: [SELF, 'abcdefghijklmnopabcdefghijklmnop'] }), { mode: 0o600 });
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded.extensionIds, [SELF, STORE, 'abcdefghijklmnopabcdefghijklmnop'], 'the store build is accepted without editing the file');
  saveConfig(dir, loaded);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).extensionIds, ['abcdefghijklmnopabcdefghijklmnop'], 'only extras are saved');
  assert.deepEqual(cfg.extensionIds, [SELF, STORE]);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...raw, extensionIds: ['not-an-id'] }), { mode: 0o600 });
  assert.throws(() => loadConfig(dir), ConfigError);
});

test('config dir resolution', () => {
  assert.equal(configDir({ CCTETHER_HOME: '/x' }), '/x');
  assert.equal(configDir({ XDG_CONFIG_HOME: '/y' }), '/y/cctether');
  assert.match(configDir({}), /\.config\/cctether$/);
});

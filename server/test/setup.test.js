// `cctether setup` and `cctether check` (SPEC §8.1, §8.2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { startGateway, makeExtension, sleep, EXT_ID } from './helpers.js';
import { checkAddress } from '../src/check.js';
import { runSetup, runCheck, normalizePublicUrl, shellJoin, caddySnippet } from '../src/setup.js';
import { renderUnit, sdQuote, UNIT_HEADER, UnitError, unitConfigDir } from '../src/system.js';
import { loadConfig, paths } from '../src/config.js';
import { decodePairingCode } from '../src/pairing.js';
import { adminRequest } from '../src/control.js';
import { spawnDaemon } from '../src/shim.js';

const CLI = fileURLToPath(new URL('../bin/cctether.js', import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

async function freePort() {
  const s = createNetServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

// --- check ---------------------------------------------------------------------------------

test('check: the right key reaches the service; a wrong key is a different server', async (t) => {
  const { gw, key, url } = await startGateway();
  t.after(() => gw.close());
  assert.deepEqual(await checkAddress({ url, key, extensionId: EXT_ID }), { ok: true });
  const r = await checkAddress({ url, key: randomBytes(32), extensionId: EXT_ID });
  assert.equal(r.reason, 'wrong_server');
});

test('check: never replaces the connected browser and never counts as a failed login', async (t) => {
  const { gw, key, url } = await startGateway();
  t.after(() => gw.close());
  const ext = makeExtension({ url, key });
  ext.start();
  t.after(() => ext.stop());
  await ext.waitFor((s) => s.conn === 'connected');
  // More checks than the failure limit (5 per minute), including ones with the wrong key.
  for (let i = 0; i < 4; i++) assert.equal((await checkAddress({ url, key, extensionId: EXT_ID })).ok, true);
  for (let i = 0; i < 4; i++) assert.equal((await checkAddress({ url, key: randomBytes(32), extensionId: EXT_ID })).reason, 'wrong_server');
  assert.equal((await checkAddress({ url, key, extensionId: EXT_ID })).ok, true, 'not rate limited');
  await sleep(100);
  assert.equal(ext.status.conn, 'connected');
  assert.equal(gw.status().connected, true);
});

test('check: explains refused ports, wrong paths, proxies that can’t reach it, and strangers', async (t) => {
  const { gw, key, port } = await startGateway();
  t.after(() => gw.close());
  const extensionId = EXT_ID;

  const closed = await freePort();
  assert.equal((await checkAddress({ url: `ws://127.0.0.1:${closed}/cctether`, key, extensionId })).reason, 'refused');

  const wrongPath = await checkAddress({ url: `ws://127.0.0.1:${port}/elsewhere`, key, extensionId });
  assert.deepEqual([wrongPath.reason, wrongPath.status], ['http', 404]);

  assert.equal((await checkAddress({ url: `ws://127.0.0.1:${port}/cctether`, key, extensionId: 'a'.repeat(32) })).reason, 'origin_rejected');

  const proxy = createServer((_req, res) => { res.writeHead(502); res.end(); });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  const bad = await checkAddress({ url: `ws://127.0.0.1:${proxy.address().port}/cctether`, key, extensionId });
  assert.deepEqual([bad.reason, bad.status], ['http', 502]);

  const other = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  other.on('connection', (ws) => ws.on('message', () => ws.send('{"hello":"world"}')));
  await new Promise((r) => other.on('listening', r));
  t.after(() => other.close());
  assert.equal((await checkAddress({ url: `ws://127.0.0.1:${other.address().port}/cctether`, key, extensionId })).reason, 'not_cctether');

  const silent = createNetServer(() => {}); // accepts, never answers
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  t.after(() => silent.close());
  const slow = await checkAddress({ url: `ws://127.0.0.1:${silent.address().port}/cctether`, key, extensionId, timeoutMs: 300 });
  assert.equal(slow.reason, 'timeout');

  assert.equal((await checkAddress({ url: 'wss://cctether-test.invalid/cctether', key, extensionId })).reason, 'dns');
});

// --- small helpers -------------------------------------------------------------------------

test('setup: public addresses are tidied up', () => {
  assert.deepEqual(normalizePublicUrl('browser.example.com'), { url: 'wss://browser.example.com/cctether', path: '/cctether', addedPath: true });
  assert.deepEqual(normalizePublicUrl('https://browser.example.com/'), { url: 'wss://browser.example.com/cctether', path: '/cctether', addedPath: true });
  assert.deepEqual(normalizePublicUrl(' wss://b.example.com:8443/cctether '), { url: 'wss://b.example.com:8443/cctether', path: '/cctether', addedPath: false });
  assert.equal(normalizePublicUrl('wss://b.example.com/tether').path, '/tether');
  assert.deepEqual(normalizePublicUrl('wss://b.example.com/cctether/'), { url: 'wss://b.example.com/cctether', path: '/cctether', addedPath: false });
  assert.equal(normalizePublicUrl('ws://b.example.com/cctether'), null);
  assert.equal(normalizePublicUrl('http://b.example.com'), null);
  assert.equal(normalizePublicUrl(''), null);
});

test('setup: the systemd unit quotes paths and can drop the sandbox', () => {
  // $ is only special on Exec lines; % everywhere; control characters are refused
  assert.equal(sdQuote('/a b/100%/$HOME"x', { exec: true }), '"/a b/100%%/$$HOME\\"x"');
  assert.equal(sdQuote('/a/$x%'), '"/a/$x%%"');
  assert.throws(() => sdQuote('/a\nExecStartPre=/bin/evil'), UnitError);
  const unit = renderUnit({ nodePath: '/opt/node 22/bin/node', cliPath: '/x/cli.js', configDir: '/h/.config/cctether', socketPath: '/h/.config/cctether/control.sock' });
  assert.ok(unit.startsWith(UNIT_HEADER));
  assert.match(unit, /^ExecStart="\/opt\/node 22\/bin\/node" "\/x\/cli.js" daemon$/m);
  assert.match(unit, /^ReadWritePaths="\/h\/.config\/cctether"$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^Environment="CCTETHER_HOME=\/h\/.config\/cctether"$/m, 'always explicit');
  assert.equal(unitConfigDir(unit), '/h/.config/cctether');
  const odd = renderUnit({ nodePath: '/n', cliPath: '/c', configDir: '/h/a "b" $5%', socketPath: '/h/a "b" $5%/control.sock' });
  assert.equal(unitConfigDir(odd), '/h/a "b" $5%');
  const custom = renderUnit({ nodePath: '/n', cliPath: '/c', configDir: '/very/long', socketPath: '/run/user/1/cctether-abc.sock', sandbox: false });
  assert.doesNotMatch(custom, /ProtectSystem|ReadWritePaths/);
  const sock = renderUnit({ nodePath: '/n', cliPath: '/c', configDir: '/very/long', socketPath: '/run/user/1/cctether-abc.sock' });
  assert.match(sock, /^ReadWritePaths="\/very\/long" "\/run\/user\/1"$/m);
  assert.match(caddySnippet('b.example.com', '/tether', 27182), /@tether path \/tether\n\s+handle @tether \{\n\s+rewrite \* \/cctether\n/);
  assert.doesNotMatch(caddySnippet('b.example.com', '/cctether', 27182), /rewrite/);
  assert.equal(shellJoin(['/a/node', '/b c/cli.js', 'mcp']), "/a/node '/b c/cli.js' mcp");
});

// --- the whole flow, with systemctl / loginctl / claude / npm faked -------------------------

/**
 * A sandbox: temp config dir, temp XDG_CONFIG_HOME for the unit file, temp Claude config, and a
 * fake `run` that records calls. systemctl start/restart really starts a daemon (from this source
 * tree), so the check step has something to talk to.
 */
async function sandbox(t, { claude = true, systemd = true, linger = false, failSandbox = false, failStart = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cct-setup-'));
  const dir = join(root, 'h');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  if (claude) { writeFileSync(join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 }); }
  const env = {
    PATH: bin, CCTETHER_HOME: dir, XDG_CONFIG_HOME: join(root, 'xdg'), CLAUDE_CONFIG_DIR: join(root, 'claude'), LANG: 'C.UTF-8',
  };
  mkdirSync(env.CLAUDE_CONFIG_DIR);
  const port = await freePort();
  const calls = [];
  const P = paths(dir, env);
  let active = false;
  let mainPid = null;
  let sandboxRejected = failSandbox;
  let lastStatus = 0;
  const unitPath = join(env.XDG_CONFIG_HOME, 'systemd', 'user', 'cctether.service');
  const claudeJson = join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  const readClaude = () => { try { return JSON.parse(readFileSync(claudeJson, 'utf8')); } catch { return { mcpServers: {} }; } };

  const startService = () => {
    const unit = readFileSync(unitPath, 'utf8');
    if (failStart) return { status: 1, stdout: '', stderr: 'Job for cctether.service failed.' };
    if (sandboxRejected && unit.includes('ProtectSystem')) { lastStatus = 226; return { status: 1, stdout: '', stderr: 'Job failed.' }; }
    // Like systemd: INVOCATION_ID is set, so the service takes over from a copy started elsewhere.
    mainPid = spawnDaemon(P, CLI, { ...process.env, ...env, INVOCATION_ID: 'test' });
    active = true;
    lastStatus = 0;
    return { status: 0, stdout: '', stderr: '' };
  };

  const runFn = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (cmd === 'systemctl') {
      if (!systemd) return { status: 1, stdout: '', stderr: 'Failed to connect to bus' };
      const a = args.slice(1);
      if (a[0] === 'show-environment' || a[0] === 'daemon-reload' || a[0] === 'reset-failed') return ok();
      if (a[0] === 'is-active') return ok(active ? 'active\n' : 'inactive\n');
      if (a[0] === 'show') return ok(a.includes('MainPID') ? `${active ? mainPid : 0}\n` : `${lastStatus}\n`);
      if (a[0] === 'enable') return ok();
      if (a[0] === 'start') return active ? ok() : startService();
      if (a[0] === 'restart') {
        if (active) adminRequest(P.socket, { cmd: 'stop' });
        return startService();
      }
    }
    if (cmd === 'loginctl') return args[0] === 'show-user' ? ok(linger ? 'yes\n' : 'no\n') : { status: 1, stdout: '', stderr: 'denied' };
    if (cmd === 'claude') {
      const cfg = readClaude();
      if (args[1] === 'add') {
        if (cfg.mcpServers.cctether) return { status: 1, stdout: '', stderr: 'MCP server cctether already exists in user config' };
        const dd = args.indexOf('--');
        const e = args.indexOf('-e');
        cfg.mcpServers.cctether = { type: 'stdio', command: args[dd + 1], args: args.slice(dd + 2), env: e > 0 ? Object.fromEntries([args[e + 1].split('=')]) : {} };
        writeFileSync(claudeJson, JSON.stringify(cfg));
        return ok('Added');
      }
      if (args[1] === 'remove') { delete cfg.mcpServers.cctether; writeFileSync(claudeJson, JSON.stringify(cfg)); return ok(); }
    }
    if (cmd === 'npm') return { status: 1, stdout: '', stderr: 'no npm in tests' };
    return { status: 127, stdout: '', stderr: `${cmd}: not found` };
  };

  t.after(async () => {
    await adminRequest(P.socket, { cmd: 'stop' });
    await sleep(200);
    rmSync(root, { recursive: true, force: true });
  });

  return {
    root, dir, env, port, calls, P, unitPath, claudeJson, readClaude,
    get active() { return active; },
    get mainPid() { return mainPid; },
    async setup(opts = {}, answers = [], extra = {}) {
      const lines = [];
      const prompts = [];
      const code = await runSetup({
        dir, version: VERSION, cliPath: CLI, opts: { port, ...opts }, env, platform: 'linux', runFn,
        write: (l) => lines.push(l), interactive: true, showCode: true,
        ask: async (p) => { prompts.push(p); if (!answers.length) throw new Error(`unexpected question: ${p}`); return answers.shift(); },
        self: { kind: 'installed', binPath: join(root, 'global', 'bin', 'cctether'), cliPath: CLI, onPath: true },
        ...extra,
      });
      return { code, out: lines.join('\n'), lines, prompts };
    },
  };
}

test('setup over HTTPS: asks, writes the service, adds to Claude Code, checks, prints the code', async (t) => {
  const sb = await sandbox(t);
  const r = await sb.setup({}, ['3', 'cctether-test.invalid', '', '']);
  assert.equal(r.code, 0, r.out);
  // Questions: mode, address, background service (default yes); nothing else
  assert.equal(r.prompts.length, 3, r.prompts.join('\n'));

  const cfg = loadConfig(sb.dir);
  assert.equal(cfg.publicUrl, 'wss://cctether-test.invalid/cctether');
  assert.equal(cfg.port, sb.port);

  const unit = readFileSync(sb.unitPath, 'utf8');
  assert.match(unit, new RegExp(`ExecStart=".*node.*" "${CLI.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}" daemon`));
  assert.match(unit, /Environment="CCTETHER_HOME=/);
  assert.ok(sb.calls.includes('systemctl --user enable cctether'));
  assert.ok(sb.calls.includes('systemctl --user start cctether'));

  const reg = sb.readClaude().mcpServers.cctether;
  assert.equal(reg.command, join(sb.root, 'global', 'bin', 'cctether'));
  assert.deepEqual(reg.args, ['mcp']);
  assert.equal(reg.env.CCTETHER_HOME, sb.dir);

  assert.match(r.out, /ws:\/\/127\.0\.0\.1:\d+\/cctether answers, and it’s this computer’s cctether/);
  assert.match(r.out, /wss:\/\/cctether-test\.invalid\/cctether: can’t find the address cctether-test\.invalid/);
  assert.match(r.out, /sudo loginctl enable-linger/);
  assert.match(r.out, /cctether-test\.invalid \{/, 'Caddy example');

  const codeLine = r.lines.find((l) => l.startsWith('cctether1:'));
  const decoded = decodePairingCode(codeLine);
  assert.equal(decoded.url, cfg.publicUrl);
  assert.ok(decoded.key.equals(cfg.key));
  // The key appears nowhere except inside the code
  assert.equal(r.out.split(cfg.key.toString('base64url')).length, 1);
});

test('setup again: keeps the key, the service and the registration; nothing to ask with --yes', async (t) => {
  const sb = await sandbox(t, { linger: true });
  const first = await sb.setup({ yes: true, mode: 'ssh' });
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /starts when the computer boots/);
  const key = loadConfig(sb.dir).key;
  const unitBefore = readFileSync(sb.unitPath, 'utf8');
  sb.calls.length = 0;

  const again = await sb.setup({ yes: true });
  assert.equal(again.code, 0, again.out);
  assert.ok(loadConfig(sb.dir).key.equals(key), 'same key');
  assert.equal(readFileSync(sb.unitPath, 'utf8'), unitBefore);
  assert.match(again.out, /→ Through an SSH tunnel/, 'remembers the SSH choice (a service is installed, no public address)');
  assert.match(again.out, /Already added to Claude Code/);
  assert.ok(!sb.calls.some((c) => c.startsWith('claude mcp add')), sb.calls.join('\n'));
  assert.ok(!sb.calls.some((c) => / (start|restart) cctether$/.test(c)), 'running service of this version is left alone');
});

test('setup keeps a hand-written service unit unless told otherwise; replaces a different Claude Code entry when asked', async (t) => {
  const sb = await sandbox(t);
  mkdirSync(join(sb.env.XDG_CONFIG_HOME, 'systemd', 'user'), { recursive: true });
  const mine = '[Service]\nExecStart=/somewhere/else daemon\n';
  writeFileSync(sb.unitPath, mine);
  writeFileSync(sb.claudeJson, JSON.stringify({ mcpServers: { cctether: { type: 'stdio', command: 'npx', args: ['cctether', 'mcp'], env: {} } } }));

  // mode 2 (ssh), service yes, overwrite? (default no), replace Claude entry? (default yes)
  const r = await sb.setup({ service: false }, ['2', '']);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(sb.unitPath, 'utf8'), mine, '--no-service leaves it alone');
  assert.match(r.prompts.at(-1), /Replace it with/);
  assert.equal(sb.readClaude().mcpServers.cctether.command, join(sb.root, 'global', 'bin', 'cctether'));

  const r2 = await sb.setup({ yes: true });
  assert.equal(readFileSync(sb.unitPath, 'utf8'), mine, 'hand-written unit kept by default');
  assert.match(r2.out, /Kept your own/);
});

test('setup retries without the sandbox when systemd can’t set it up (status 226)', async (t) => {
  const sb = await sandbox(t, { failSandbox: true });
  const r = await sb.setup({ yes: true, mode: 'ssh' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Background service installed and running/);
  const unit = readFileSync(sb.unitPath, 'utf8');
  assert.doesNotMatch(unit, /ProtectSystem/);
  assert.match(unit, /NoNewPrivileges=yes/);
});

test('setup without systemd or claude: explains instead, and still works', async (t) => {
  const sb = await sandbox(t, { claude: false, systemd: false });
  const r = await sb.setup({ yes: true, mode: 'local' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /systemd isn’t available/);
  assert.match(r.out, /isn’t on this computer’s PATH/);
  assert.match(r.out, /"CCTETHER_HOME"/, 'MCP client JSON carries the custom config folder');
  assert.match(r.out, /answers, and it’s this computer’s cctether/);
  assert.ok(!existsSync(sb.unitPath));
});

test('setup switches from HTTPS back to local, and refuses bad input', async (t) => {
  const sb = await sandbox(t, { systemd: false });
  await sb.setup({ yes: true, mode: 'https', url: 'wss://cctether-test.invalid/cctether' });
  assert.equal(loadConfig(sb.dir).publicUrl, 'wss://cctether-test.invalid/cctether');
  await sb.setup({ yes: true, mode: 'local' });
  assert.equal(loadConfig(sb.dir).publicUrl, null);

  const bad = await sb.setup({ yes: true, mode: 'https', url: 'ws://cctether-test.invalid' });
  assert.equal(bad.code, 2);
  // Interactive: a wrong menu answer and a wrong address are asked again
  // Answers that make no sense, forever (not a person at the keyboard): setup gives up instead of spinning
  const spin = await sb.setup({}, Array(50).fill('banana'));
  assert.equal(spin.code, 2);
  assert.match(spin.out, /too many answers/);
  const r = await sb.setup({}, ['7', '3', 'http://nope', 'wss://cctether-test.invalid/x']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Type 1, 2 or 3/);
  assert.match(r.out, /must start with wss:\/\//);
  assert.match(r.out, /rewrite \/x to \/cctether/);
});

test('setup needs a terminal or --yes; refuses Windows; speaks Chinese when asked', async (t) => {
  const sb = await sandbox(t, { systemd: false });
  const lines = [];
  const base = { dir: sb.dir, version: VERSION, cliPath: CLI, env: sb.env, write: (l) => lines.push(l), ask: async () => '' };
  assert.equal(await runSetup({ ...base, opts: {}, interactive: false, platform: 'linux' }), 2);
  assert.match(lines.pop(), /pass --yes/);
  assert.equal(await runSetup({ ...base, opts: { yes: true }, interactive: false, platform: 'win32' }), 1);
  assert.match(lines.pop(), /WSL/);

  const zh = await sb.setup({ yes: true, mode: 'local', lang: 'zh' });
  assert.equal(zh.code, 0);
  assert.match(zh.out, /cctether 安装向导/);
  assert.match(zh.out, /有回应，是这台电脑上的 cctether/);
  assert.match(zh.out, /README\.zh-CN\.md#安装插件/);
});

test('setup from npx installs cctether first (or explains why it can’t)', async (t) => {
  const sb = await sandbox(t, { systemd: false, claude: false });
  // A fake global npm prefix the fake `npm install -g` fills with a copy that points at this tree
  const prefix = join(sb.root, 'npm-global');
  mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
  const npx = { kind: 'npx', cliPath: '/home/u/.npm/_npx/123/node_modules/cctether/bin/cctether.js' };
  // Real npx puts its temporary copy first on PATH; it must not count as "installed".
  const npxPkg = join(sb.root, 'npmcache', '_npx', 'abc', 'node_modules', 'cctether');
  const npxBin = join(sb.root, 'npmcache', '_npx', 'abc', 'node_modules', '.bin');
  mkdirSync(join(npxPkg, 'bin'), { recursive: true });
  mkdirSync(npxBin, { recursive: true });
  writeFileSync(join(npxPkg, 'package.json'), JSON.stringify({ name: 'cctether', version: VERSION }));
  writeFileSync(join(npxPkg, 'bin', 'cctether.js'), '', { mode: 0o755 });
  symlinkSync(join(npxPkg, 'bin', 'cctether.js'), join(npxBin, 'cctether'));
  const env = { ...sb.env, PATH: `${npxBin}:${sb.env.PATH}` };
  const calls = [];
  const runFn = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'npm' && args[0] === 'prefix') return { status: 0, stdout: prefix + '\n', stderr: '' };
    if (cmd === 'npm' && args[0] === 'install') {
      const pkg = join(prefix, 'lib', 'node_modules', 'cctether');
      mkdirSync(join(pkg, 'bin'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'cctether', version: VERSION }));
      writeFileSync(join(pkg, 'bin', 'cctether.js'), `import ${JSON.stringify(CLI)};\n`);
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      symlinkSync(join(pkg, 'bin', 'cctether.js'), join(prefix, 'bin', 'cctether'));
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: '' };
  };
  const lines = [];
  const code = await runSetup({
    dir: sb.dir, version: VERSION, cliPath: npx.cliPath, self: npx, opts: { yes: true, mode: 'local', port: sb.port }, env,
    platform: 'linux', runFn, write: (l) => lines.push(l), interactive: false, ask: async () => '',
    // the copy above just imports this tree's CLI; start the daemon from the tree itself
    startDaemon: (P, _cli, e) => spawnDaemon(P, CLI, e),
  });
  const out = lines.join('\n');
  assert.equal(code, 0, out);
  assert.ok(calls.includes(`npm install -g cctether@${VERSION}`), calls.join('\n'));
  assert.doesNotMatch(out, /_npx/, 'nothing points into the npx cache');
  assert.match(out, new RegExp(`Installed cctether ${VERSION.replace(/\./g, '\\.')}`));
  assert.match(out, /isn’t on your PATH/);
  assert.match(out, new RegExp(`claude mcp add -s user cctether -e CCTETHER_HOME=\\S+ -- ${join(prefix, 'bin', 'cctether').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} mcp`));

  // Declining the install stops setup before anything else happens (an empty npm folder this time)
  const emptyPrefix = join(sb.root, 'npm-empty');
  mkdirSync(emptyPrefix);
  const runEmpty = (cmd, args) => (cmd === 'npm' && args[0] === 'prefix' ? { status: 0, stdout: emptyPrefix + '\n', stderr: '' } : runFn(cmd, args));
  const lines2 = [];
  const declined = await runSetup({
    dir: join(sb.root, 'other'), version: VERSION, cliPath: npx.cliPath, self: npx, opts: {}, env: { ...env, CCTETHER_HOME: join(sb.root, 'other') },
    platform: 'linux', runFn: runEmpty, write: (l) => lines2.push(l), interactive: true, ask: async () => 'n',
  });
  assert.equal(declined, 1);
  assert.match(lines2.join('\n'), /npm install -g cctether/);
  assert.ok(!existsSync(join(sb.root, 'other', 'config.json')));

  // --no-install from npx: explain and stop, without running npm
  calls.length = 0;
  const lines3 = [];
  const noInstall = await runSetup({
    dir: join(sb.root, 'other'), version: VERSION, cliPath: npx.cliPath, self: npx, opts: { yes: true, install: false, mode: 'local' },
    env: { ...env, CCTETHER_HOME: join(sb.root, 'other') }, platform: 'linux', runFn, write: (l) => lines3.push(l), interactive: false, ask: async () => '',
  });
  assert.equal(noInstall, 1);
  assert.match(lines3.join('\n'), /--no-install/);
  assert.ok(!calls.some((c) => c.startsWith('npm install')));
  assert.ok(!existsSync(join(sb.root, 'other', 'config.json')));
});

test('setup with --yes never replaces a different Claude Code entry, and checks flags before changing anything', async (t) => {
  const sb = await sandbox(t, { systemd: false });
  writeFileSync(sb.claudeJson, JSON.stringify({ mcpServers: { cctether: { type: 'stdio', command: '/my/wrapper', args: ['mcp'], env: { HTTPS_PROXY: 'x' } } } }));
  const r = await sb.setup({ yes: true, mode: 'local' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Kept it: --yes doesn’t replace it/);
  assert.equal(sb.readClaude().mcpServers.cctether.command, '/my/wrapper');

  const sb2 = await sandbox(t, { systemd: false });
  const bad = await sb2.setup({ yes: true, mode: 'https' });
  assert.equal(bad.code, 2);
  assert.match(bad.out, /give the address with --url/);
  assert.ok(!existsSync(join(sb2.dir, 'config.json')), 'no key made for a run that was going to fail');
  const bad2 = await sb2.setup({ yes: true, mode: 'https', url: 'ftp://x' });
  assert.equal(bad2.code, 2);
  assert.ok(!existsSync(join(sb2.dir, 'config.json')));
});

test('setup reports failure: exit code 1 and a different closing line when the service won’t start', async (t) => {
  const sb = await sandbox(t, { failStart: true });
  const r = await sb.setup({ yes: true, mode: 'ssh' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /The background service didn’t start: Job for cctether.service failed/);
  assert.match(r.out, /Something above needs fixing/);
  assert.doesNotMatch(r.out, /This computer is ready/);
});

test('setup only prints the connection code on a terminal', async (t) => {
  const sb = await sandbox(t, { systemd: false });
  const r = await sb.setup({ yes: true, mode: 'local' }, [], { showCode: false });
  assert.equal(r.code, 0, r.out);
  assert.ok(!r.lines.some((l) => l.includes('cctether1:')), r.out);
  assert.match(r.out, /run `cctether pair` in a terminal/);
});

test('setup hands a service Claude Code started over to systemd', async (t) => {
  const sb = await sandbox(t, { linger: true });
  await sb.setup({ yes: true, mode: 'ssh', service: false });
  const before = await adminRequest(sb.P.socket, { cmd: 'status' });
  assert.ok(before?.ok, 'a copy started outside systemd is running');
  const r = await sb.setup({ yes: true, mode: 'ssh' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Background service installed and running/);
  const after = await adminRequest(sb.P.socket, { cmd: 'status' });
  assert.equal(after.pid, sb.mainPid, 'the service answering is the one systemd started');
  assert.notEqual(after.pid, before.pid);
});

test('setup won’t silently take over a service unit written for another settings folder', async (t) => {
  const sb = await sandbox(t);
  mkdirSync(join(sb.env.XDG_CONFIG_HOME, 'systemd', 'user'), { recursive: true });
  const other = renderUnit({ nodePath: '/n', cliPath: '/c', configDir: '/somewhere/else', socketPath: '/somewhere/else/control.sock' });
  writeFileSync(sb.unitPath, other);
  const r = await sb.setup({ yes: true, mode: 'ssh' });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(sb.unitPath, 'utf8'), other);
  assert.match(r.out, /Kept your own/);
  assert.ok(!sb.calls.some((c) => / (start|restart) cctether$/.test(c)), 'the other service isn’t touched');
});

test('cctether check on its own: reports the service, the addresses and the browser', async (t) => {
  const sb = await sandbox(t, { systemd: false });
  const lines = [];
  assert.equal(await runCheck({ dir: sb.dir, version: VERSION, write: (l) => lines.push(l), env: sb.env }), 3, 'not set up');
  await sb.setup({ yes: true, mode: 'https', url: 'wss://cctether-test.invalid/cctether' });
  lines.length = 0;
  assert.equal(await runCheck({ dir: sb.dir, version: VERSION, write: (l) => lines.push(l), env: sb.env }), 1);
  const out = lines.join('\n');
  assert.match(out, /service is running/);
  assert.match(out, /answers, and it’s this computer’s cctether/);
  assert.match(out, /can’t find the address/);
  assert.match(out, /No browser is connected/);

  // A stale service version is pointed out
  lines.length = 0;
  await runCheck({ dir: sb.dir, version: '99.0.0', write: (l) => lines.push(l), env: sb.env });
  assert.match(lines.join('\n'), /The running service is version .*, but this is 99\.0\.0/);

  await adminRequest(sb.P.socket, { cmd: 'stop' });
  await sleep(300);
  lines.length = 0;
  assert.equal(await runCheck({ dir: sb.dir, version: VERSION, write: (l) => lines.push(l), env: sb.env }), 3);
  assert.match(lines.join('\n'), /isn’t running/);
});

test('cli: setup flags are parsed and checked', async () => {
  const { spawnSync } = await import('node:child_process');
  const home = mkdtempSync(join(tmpdir(), 'cct-cli-'));
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', env: { ...process.env, CCTETHER_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(run('setup', '--mode', 'tunnel').stderr, /--mode must be local, ssh or https/);
  assert.match(run('setup', '--lang', 'fr').stderr, /--lang must be en or zh/);
  const r = run('setup'); // stdin is not a terminal
  assert.equal(r.status, 2);
  assert.match(r.stdout, /pass --yes/);
  assert.match(run('help').stdout, /setup .*start here/);
  rmSync(home, { recursive: true, force: true });
});


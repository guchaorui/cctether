// What `cctether setup` needs to know about this computer (SPEC §8.1): where cctether is installed,
// npm, systemd user services, and Claude Code's MCP registration. Every outside command goes through
// `run` so tests can fake it.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';

/**
 * Run a program. Never throws.
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: Error }}
 */
export function run(cmd, args = [], { timeoutMs = 60_000, inherit = false, env } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env: env ?? process.env,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

/** True for folders npx puts on PATH (its temporary cache, or a project's node_modules/.bin). */
export function isNpxDir(d) {
  const parts = d.split(sep);
  return parts.includes('_npx') || (parts.at(-1) === '.bin' && parts.at(-2) === 'node_modules');
}

/** Find a program on PATH. With skipNpx, folders that npx added are ignored. */
export function findOnPath(name, env = process.env, { skipNpx = false } = {}) {
  for (const d of (env.PATH ?? '').split(delimiter)) {
    if (!d || (skipNpx && isNpxDir(d))) continue;
    const p = join(d, name);
    try {
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return p;
      }
    } catch {}
  }
  return null;
}

function realpath(p) {
  try { return realpathSync(p); } catch { return null; }
}

/** The version of the cctether package that a bin path or cli path belongs to. */
export function versionAt(path) {
  const real = realpath(path);
  if (!real) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(dirname(real)), 'package.json'), 'utf8'));
    return pkg.name === 'cctether' ? pkg.version : null;
  } catch {
    return null;
  }
}

export function npmGlobalPrefix(runFn = run) {
  const r = runFn('npm', ['prefix', '-g'], { timeoutMs: 30_000 });
  const p = r.status === 0 ? r.stdout.trim() : '';
  return p || null;
}

/** Can this user install into npm's global folder? */
export function npmPrefixWritable(prefix) {
  const target = existsSync(join(prefix, 'lib', 'node_modules')) ? join(prefix, 'lib', 'node_modules') : prefix;
  try {
    accessSync(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where is the running cctether?
 * - installed: a normal npm install; `binPath` is the `cctether` command (onPath: whether PATH finds it)
 * - npx: inside npm's temporary npx cache, which may be cleaned up at any time
 * - checkout: some other folder, e.g. a git checkout run with `node server/bin/cctether.js`
 */
export function locateSelf({ cliPath, env = process.env, runFn = run }) {
  const real = realpath(cliPath) ?? cliPath;
  if (real.split(sep).includes('_npx')) return { kind: 'npx', cliPath: real };
  const onPath = findOnPath('cctether', env);
  if (onPath && realpath(onPath) === real) return { kind: 'installed', binPath: onPath, cliPath: real, onPath: true };
  const prefix = npmGlobalPrefix(runFn);
  if (prefix) {
    const bin = join(prefix, 'bin', 'cctether');
    if (realpath(bin) === real) return { kind: 'installed', binPath: bin, cliPath: real, onPath: false };
  }
  return { kind: 'checkout', cliPath: real };
}

/** The command line MCP clients should run: [command, ...args]. */
export function mcpCommand(self, nodePath = process.execPath) {
  return self.kind === 'installed' ? [self.binPath, 'mcp'] : [nodePath, self.cliPath, 'mcp'];
}

// --- Claude Code ---------------------------------------------------------------------------

export function claudeConfigFile(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
}

/**
 * The user-scope "cctether" MCP server Claude Code already has, read from its config file.
 * @returns {{ command: string, args: string[], env: object } | null | undefined}  undefined = can't tell
 */
export function claudeRegistration(env = process.env) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(claudeConfigFile(env), 'utf8'));
  } catch (e) {
    return e.code === 'ENOENT' ? null : undefined;
  }
  const s = cfg?.mcpServers?.cctether;
  if (!s) return null;
  if (typeof s.command !== 'string') return undefined;
  return { command: s.command, args: Array.isArray(s.args) ? s.args : [], env: s.env ?? {} };
}

/** Claude Code's personal instructions file (its "user memory"), read by every session. */
export function claudeMdFile(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md') : join(homedir(), '.claude', 'CLAUDE.md');
}

const MD_START_LINE = /^<!-- cctether:start\b.*-->\s*$/;
const MD_END_LINE = /^<!-- cctether:end -->\s*$/;

/**
 * Where the cctether note is in CLAUDE.md text. Markers only count as whole lines, and only one
 * start line followed by one end line is a note; anything else is left alone ('ambiguous').
 * @returns {{ state: 'absent'|'present'|'empty'|'ambiguous', lines: string[], eol: string, start?: number, end?: number }}
 */
export function findClaudeMdNote(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const starts = [];
  const ends = [];
  lines.forEach((l, i) => {
    if (MD_START_LINE.test(l)) starts.push(i);
    else if (MD_END_LINE.test(l)) ends.push(i);
  });
  if (!starts.length && !ends.length) return { state: 'absent', lines, eol };
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) return { state: 'ambiguous', lines, eol };
  const [start] = starts;
  const [end] = ends;
  const inside = lines.slice(start + 1, end).some((l) => l.trim());
  // A block someone emptied means "no thanks": it is only filled again when asked to.
  return { state: inside ? 'present' : 'empty', lines, eol, start, end };
}

/** Read CLAUDE.md as text; '' if it doesn't exist. Throws if it isn't valid UTF-8 (we'd damage it). */
export function readClaudeMd(path) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

/**
 * Add or refresh the marked cctether note in CLAUDE.md, keeping everything else exactly as it is.
 * Written in place (not via a temporary file), so a symlink, hard links and the file's permissions
 * stay as they were, and a read-only file fails instead of being replaced.
 * @returns {'added'|'updated'|'same'|'ambiguous'|'optedOut'}
 */
export function upsertClaudeMdNote(path, body, comment, { force = false } = {}) {
  const text = readClaudeMd(path);
  const note = findClaudeMdNote(text);
  if (note.state === 'ambiguous') return 'ambiguous';
  if (note.state === 'empty' && !force) return 'optedOut';
  const block = [`<!-- cctether:start ${comment} -->`, ...body.trim().split('\n'), '<!-- cctether:end -->'];
  let lines;
  let result;
  if (note.state === 'absent') {
    lines = text ? [...note.lines] : [];
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    if (lines.length) lines.push('');
    lines.push(...block, '');
    result = 'added';
  } else {
    lines = [...note.lines.slice(0, note.start), ...block, ...note.lines.slice(note.end + 1)];
    result = 'updated';
  }
  const next = lines.join(note.eol);
  if (next === text) return 'same';
  if (!text) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return result;
}

// --- systemd -------------------------------------------------------------------------------

export const UNIT_NAME = 'cctether';
export const UNIT_HEADER = '# Written by `cctether setup`. Run it again to update this file.';

export function systemdUserAvailable(runFn = run) {
  const r = runFn('systemctl', ['--user', 'show-environment'], { timeoutMs: 15_000 });
  return r.status === 0;
}

export function unitFile(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'systemd', 'user', `${UNIT_NAME}.service`);
}

export class UnitError extends Error {}

/**
 * Quote one word for a systemd unit file: quotes, backslashes and % specifiers everywhere, and $
 * variables only on Exec lines (elsewhere $ has no special meaning). Control characters such as a
 * newline can't be written safely, so such paths are refused.
 */
export function sdQuote(s, { exec = false } = {}) {
  s = String(s);
  if (/[\x00-\x1f\x7f]/.test(s)) throw new UnitError(`a path contains a control character: ${JSON.stringify(s)}`);
  let q = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (exec) q = q.replace(/\$/g, '$$$$');
  return `"${q}"`;
}

/** The config folder a unit file's service uses, if it says so (CCTETHER_HOME), else null. */
export function unitConfigDir(content) {
  const m = /^Environment="CCTETHER_HOME=((?:[^"\\]|\\.)*)"$/m.exec(content ?? '');
  return m ? m[1].replace(/%%/g, '%').replace(/\\(.)/g, '$1') : null;
}

/**
 * The service unit. `sandbox` adds systemd's file-system protection: everything read-only except
 * the config folder. Some systems don't allow it for user services; setup then retries without.
 */
export function renderUnit({ nodePath, cliPath, configDir, socketPath, sandbox = true }) {
  const rw = [configDir];
  if (socketPath && !socketPath.startsWith(configDir + sep)) rw.push(dirname(socketPath));
  const lines = [
    UNIT_HEADER,
    '[Unit]',
    'Description=cctether: browser tools for Claude Code',
    'After=network.target',
    '',
    '[Service]',
    'Type=exec',
    // --takeover: if Claude Code already started a copy, this one replaces it (see daemon.js).
    `ExecStart=${sdQuote(nodePath, { exec: true })} ${sdQuote(cliPath, { exec: true })} daemon --takeover`,
    // Always explicit: the service must use the same folder (and key) as this setup run.
    `Environment=${sdQuote(`CCTETHER_HOME=${configDir}`)}`,
    'Restart=always',
    'RestartSec=2',
    'NoNewPrivileges=yes',
    ...(sandbox ? ['PrivateTmp=yes', 'ProtectSystem=strict', `ReadWritePaths=${rw.map(sdQuote).join(' ')}`] : []),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

export function serviceActive(runFn = run) {
  const r = runFn('systemctl', ['--user', 'is-active', UNIT_NAME], { timeoutMs: 15_000 });
  return r.stdout.trim() === 'active';
}

/** The service's main process ID according to systemd, or null. */
export function serviceMainPid(runFn = run) {
  const r = runFn('systemctl', ['--user', 'show', UNIT_NAME, '-p', 'MainPID', '--value'], { timeoutMs: 15_000 });
  const n = Number(r.stdout.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Exit status of the service's last start: 226 means systemd couldn't set up the sandbox. */
export function serviceExitStatus(runFn = run) {
  const r = runFn('systemctl', ['--user', 'show', UNIT_NAME, '-p', 'ExecMainStatus', '--value'], { timeoutMs: 15_000 });
  const n = Number(r.stdout.trim());
  return Number.isInteger(n) ? n : null;
}

export function lingerEnabled(runFn = run, user = userInfo().username) {
  const r = runFn('loginctl', ['show-user', user, '-p', 'Linger', '--value'], { timeoutMs: 15_000 });
  return r.status === 0 && r.stdout.trim() === 'yes';
}

/** Try to turn on linger without sudo (works where polkit allows it for yourself). */
export function tryEnableLinger(runFn = run) {
  const r = runFn('loginctl', ['--no-ask-password', 'enable-linger'], { timeoutMs: 15_000 });
  return r.status === 0;
}

// `cctether setup` (SPEC §8.1): install, key, how the browser connects, background service,
// Claude Code registration, a self-check, and the connection code. Safe to run again: finished steps
// are reported and skipped, the key is never replaced (that's `cctether rotate`), and a service unit
// or Claude Code entry that setup didn't write is only replaced when the user says so.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  WS_PATH, paths, loadConfig, initConfig, saveConfig, serverUrl, localUrl, isValidServerUrl,
} from './config.js';
import { encodePairingCode, keyFingerprint } from './pairing.js';
import { adminRequest } from './control.js';
import { spawnDaemon } from './shim.js';
import { checkAddress, explainCheck } from './check.js';
import { createText, pickLanguage } from './text.js';
import * as sys from './system.js';

const MODES = ['local', 'ssh', 'https'];

/** ANSI styling, only when writing to a terminal that wants colour. */
export function createStyle(enabled) {
  const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  const bold = wrap('1'), dim = wrap('2'), green = wrap('32'), red = wrap('31'), yellow = wrap('33'), cyan = wrap('36');
  return { bold, dim, green, red, yellow, cyan, ok: green('✓'), bad: red('✗'), warn: yellow('!'), dot: dim('·') };
}

/** Text shared by setup and check: prints lines with a fixed left margin. */
export function createPrinter(write, style) {
  const BODY = '     ';
  return {
    blank: () => write(''),
    title: (s, sub) => { write(''); write(`  ${style.bold(s)}`); if (sub) write(`  ${style.dim(sub)}`); },
    step: (n, s) => { write(''); write(`  ${style.cyan(String(n))}  ${style.bold(s)}`); },
    line: (s) => { for (const l of String(s).split('\n')) write(l ? BODY + l : ''); },
    code: (s) => { for (const l of String(s).split('\n')) write(l ? BODY + '  ' + style.dim(l) : ''); },
    raw: write,
  };
}

/** The config folder cctether uses when nothing is set (what a service or Claude Code would get). */
const defaultConfigDir = () => join(homedir(), '.config', 'cctether');

/**
 * @param {object} c
 * @param {string} c.dir           config directory
 * @param {string} c.version
 * @param {string} c.cliPath       bin/cctether.js of this copy
 * @param {object} c.opts          parsed flags: yes, mode, url, port, lang, install, service, mcp
 * @param {(line: string) => void} c.write
 * @param {(prompt: string) => Promise<string>} c.ask   reads one answer (not used with --yes)
 * @param {boolean} c.interactive  stdin and stdout are a terminal
 * @param {boolean} [c.showCode]   print the connection code (only when the output is a terminal)
 * @param {boolean} [c.color]
 * @param {object} [c.env]
 * @param {string} [c.platform]
 * @param {Function} [c.runFn]     sys.run replacement (tests)
 * @param {object} [c.self]        locateSelf() result (tests)
 * @param {Function} [c.startDaemon] (P, cliPath, env) => void
 * @returns {Promise<number>} exit code: 0 done, 1 something failed, 2 bad input
 */
export async function runSetup(c) {
  const env = c.env ?? process.env;
  const platform = c.platform ?? process.platform;
  const baseRun = c.runFn ?? sys.run;
  const runFn = (cmd, args, o = {}) => baseRun(cmd, args, { env, ...o });
  const opts = c.opts ?? {};
  const style = createStyle(!!c.color);
  const t = createText(pickLanguage(opts.lang, env), style);
  const out = createPrinter(c.write, style);
  const startDaemon = c.startDaemon ?? spawnDaemon;
  const P = paths(c.dir, env);

  if (platform === 'win32') {
    c.write(t('setup.windows'));
    return 1;
  }
  if (!opts.yes && !c.interactive) {
    c.write(t('setup.needTty'));
    return 2;
  }

  // Check the flags before changing anything.
  let mode = opts.mode ?? (opts.url ? (isLocalUrl(opts.url) ? 'local' : 'https') : null);
  let flagUrl = null;
  if (opts.url !== undefined) {
    if (mode === 'https') {
      flagUrl = normalizePublicUrl(opts.url);
      if (!flagUrl || !isValidServerUrl(flagUrl.url)) {
        c.write(t('mode.https.invalid'));
        return 2;
      }
    } else if (isLocalUrl(opts.url) && isValidServerUrl(opts.url)) flagUrl = { url: opts.url };
  }
  if (opts.yes && mode === 'https' && !flagUrl) {
    const prev = safeLoadConfig(c.dir)?.publicUrl;
    if (!prev || isLocalUrl(prev)) {
      c.write(t('setup.needUrl'));
      return 2;
    }
  }

  /** Ask yes/no. With --yes, answer `yesAnswer` (default: the same as the default). */
  const yn = async (question, def, yesAnswer = def) => {
    if (opts.yes) return yesAnswer;
    for (let tries = 0; ; tries++) {
      if (tries >= MAX_TRIES) throw new TooManyTries();
      const a = (await c.ask(`${BODY_PROMPT(style)}${question} ${style.dim(`[${def ? t('setup.yes') : t('setup.no')}]`)} `)).trim().toLowerCase();
      if (!a) return def;
      if (['y', 'yes', '是', '好', '要'].includes(a)) return true;
      if (['n', 'no', '否', '不', '不要'].includes(a)) return false;
    }
  };
  try {
    return await steps();
  } catch (e) {
    if (!(e instanceof TooManyTries)) throw e;
    out.line(t('setup.tooManyTries'));
    return 2;
  }

  async function steps() {
    let problems = false;

    out.title(t('setup.title'), t('setup.tagline'));

    // 1. Install ------------------------------------------------------------------------------
    out.step(1, t('step.install'));
    let self = c.self ?? sys.locateSelf({ cliPath: c.cliPath, env, runFn });
    if (self.kind === 'npx') {
      if (opts.install === false) {
        out.line(t('install.noInstall'));
        return 1;
      }
      self = await installFromNpx({ c, t, out, yn, runFn, env });
      if (!self) return 1;
    } else if (self.kind === 'installed') {
      out.line(t('install.ok', { version: c.version, path: self.binPath }));
      if (!self.onPath) out.line(t('install.notOnPath', { dir: dirname(self.binPath) }));
    } else {
      out.line(t('install.checkout', { path: dirname(dirname(self.cliPath)) }));
    }

    // 2. Key ----------------------------------------------------------------------------------
    out.step(2, t('step.key'));
    let { cfg, created } = initConfig(c.dir, { port: opts.port });
    if (opts.port !== undefined && opts.port !== cfg.port) {
      cfg.port = opts.port;
      saveConfig(c.dir, cfg);
    }
    out.line(t(created ? 'key.created' : 'key.exists', { fp: keyFingerprint(cfg.key), path: P.config }));

    // 3. How the browser connects -------------------------------------------------------------
    out.step(3, t('step.mode'));
    const unitPath = sys.unitFile(env);
    const hadUnit = existsSync(unitPath);
    let asked = false;
    if (!mode) {
      const current = cfg.publicUrl && !isLocalUrl(cfg.publicUrl) ? 'https' : hadUnit ? 'ssh' : 'local';
      if (opts.yes) mode = current;
      else {
        asked = true;
        MODES.forEach((m, i) => out.line(`${style.cyan(`${i + 1})`)} ${t(`mode.${m}`)}`));
        const def = MODES.indexOf(current) + 1;
        for (let tries = 0; ; tries++) {
          if (tries >= MAX_TRIES) throw new TooManyTries();
          const a = (await c.ask(`${BODY_PROMPT(style)}${t('mode.choose')} ${style.dim(`[${def}]`)}: `)).trim();
          const n = a ? Number(a) : def;
          if (n >= 1 && n <= 3) { mode = MODES[n - 1]; break; }
          out.line(t('mode.invalid'));
        }
      }
    }
    if (!asked) out.line(`${style.cyan('→')} ${t(`mode.${mode}`)}`);

    let publicUrl;
    if (mode === 'https') {
      const previous = cfg.publicUrl && !isLocalUrl(cfg.publicUrl) ? cfg.publicUrl : null;
      let fixed = flagUrl;
      for (let tries = 0; !fixed; tries++) {
        if (tries >= MAX_TRIES) throw new TooManyTries();
        const a = opts.yes ? previous : (await c.ask(`${BODY_PROMPT(style)}${t('mode.https.ask')}${previous ? ' ' + style.dim(`[${previous}]`) : ''}: `)).trim() || previous;
        if (!a) continue;
        fixed = normalizePublicUrl(a);
        if (!fixed || !isValidServerUrl(fixed.url)) {
          out.line(t('mode.https.invalid'));
          fixed = null;
        }
      }
      publicUrl = fixed.url;
      if (fixed.addedPath) out.line(t('mode.https.addedPath', { url: publicUrl }));
      else if (fixed.path !== WS_PATH) out.line(t('mode.https.otherPath', { path: fixed.path }));
    } else {
      // Same computer or SSH tunnel: the local address, or a local one given by hand (another port).
      publicUrl = flagUrl?.url ?? (cfg.publicUrl && isLocalUrl(cfg.publicUrl) ? cfg.publicUrl : null);
    }

    if (cfg.publicUrl !== publicUrl) {
      cfg.publicUrl = publicUrl;
      saveConfig(c.dir, cfg);
    }
    await adminRequest(P.socket, { cmd: 'reload' }); // a running service picks up the address
    const url = serverUrl(cfg);
    if (mode === 'local') out.line(t('mode.local.note', { url }));
    if (mode === 'ssh') out.line(t('mode.ssh.note', { url, port: cfg.port }));
    if (mode === 'https') {
      const u = new URL(publicUrl);
      out.line(t('mode.https.proxy', { url: publicUrl, port: cfg.port }));
      out.blank();
      out.code(caddySnippet(u.host, u.pathname, cfg.port));
      out.blank();
      out.line(t('mode.https.more'));
    }

    // 4. Background service -------------------------------------------------------------------
    out.step(4, t('step.service'));
    let managed = false; // systemd runs our service
    if (platform === 'darwin') out.line(t('service.mac'));
    else if (platform !== 'linux' || !sys.systemdUserAvailable(runFn)) out.line(t('service.noSystemd'));
    else {
      const remote = mode !== 'local';
      const want = opts.service === false ? false
        : await yn(t(remote || hadUnit ? 'service.ask.remote' : 'service.ask.local'), remote || hadUnit);
      if (!want) out.line(t('service.skipped'));
      else {
        const r = await installService({ c, t, out, yn, runFn, P, self, unitPath, cfg });
        managed = r.managed;
        if (!r.ok) problems = true;
      }
    }

    // 5. Claude Code --------------------------------------------------------------------------
    out.step(5, t('step.claude'));
    const cmd = sys.mcpCommand(self);
    const customHome = c.dir !== defaultConfigDir();
    const shown = shellJoin(cmd);
    const addLine = `claude mcp add -s user cctether${customHome ? ` -e ${shellJoin([`CCTETHER_HOME=${c.dir}`])}` : ''} -- ${shown}`;
    if (opts.mcp === false) out.line(t('claude.skipped', { cmd: addLine }));
    else if (!sys.findOnPath('claude', env)) {
      const json = JSON.stringify({ command: cmd[0], args: cmd.slice(1), ...(customHome ? { env: { CCTETHER_HOME: c.dir } } : {}) });
      out.line(t('claude.missing', { cmd: addLine, json }));
    } else if (!(await registerWithClaude({ t, out, yn, runFn, env, cmd, dir: c.dir, customHome, yes: !!opts.yes }))) {
      problems = true;
    } else {
      // Only once Claude Code has the tools: the note tells Claude to use them.
      await claudeMdStep({ t, out, yn, env, opts });
    }

    // 6. Check --------------------------------------------------------------------------------
    out.step(6, t('step.check'));
    const up = await ensureRunning({ t, out, runFn, env, P, cfg, version: c.version, self, managed, startDaemon });
    if (!up) problems = true;
    else {
      const results = await checkUrls({ t, out, cfg, publicUrl: mode === 'https' ? publicUrl : null });
      if (!results.localOk) problems = true;
      if (mode === 'https' && !results.publicOk) {
        if (HAIRPIN_REASONS.has(results.publicReason)) out.line(style.dim(t('check.hairpin')));
        out.line(t('check.later'));
      }
    }

    // Connection code ------------------------------------------------------------------------
    cfg = loadConfig(c.dir) ?? cfg;
    out.blank();
    out.raw(`  ${style.bold(t(problems ? 'final.titleProblem' : 'final.title'))}`);
    out.line(`1. ${t('final.step1')}`);
    if (c.showCode) {
      out.line(`2. ${t('final.step2')}`);
      out.blank();
      out.raw(encodePairingCode(serverUrl(cfg), cfg.key));
      out.blank();
      out.line(t('final.secret'));
      out.line(style.dim(t('final.again')));
    } else {
      // Not a terminal (a script, a log, another program): the code is a secret, so it isn't printed.
      out.line(`2. ${t('final.step2.hidden')}`);
    }
    out.line(t('final.restart'));
    out.blank();
    return problems ? 1 : 0;
  }
}

/** Questions give up after this many answers that don't make sense (e.g. input that isn't a person). */
const MAX_TRIES = 10;
class TooManyTries extends Error {}

/** Failures that can come from a server that can't reach its own public address. */
const HAIRPIN_REASONS = new Set(['timeout', 'refused', 'closed', 'error']);

const BODY_PROMPT = (style) => `     ${style.cyan('?')} `;

function isLocalUrl(u) {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname);
  } catch {
    return false;
  }
}

function safeLoadConfig(dir) {
  try { return loadConfig(dir); } catch { return null; }
}

/**
 * Accept "browser.example.com", "wss://browser.example.com" or a full URL. Adds /cctether when
 * there's no path and drops a trailing slash. Returns null for anything that isn't wss/https.
 */
export function normalizePublicUrl(input) {
  let s = String(input).trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `wss://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol === 'https:') u = new URL(`wss:${s.slice(s.indexOf('//'))}`);
  if (u.protocol !== 'wss:') return null;
  let addedPath = false;
  if (u.pathname === '/' || u.pathname === '') {
    u.pathname = WS_PATH;
    addedPath = true;
  } else if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
  return { url: u.toString(), path: u.pathname, addedPath };
}

/** A complete Caddy site block; a path other than /cctether is rewritten to it. */
export function caddySnippet(host, path, port) {
  return [
    `${host} {`,
    `\t@tether path ${path}`,
    '\thandle @tether {',
    ...(path !== WS_PATH ? [`\t\trewrite * ${WS_PATH}`] : []),
    `\t\treverse_proxy 127.0.0.1:${port}`,
    '\t}',
    '\thandle {',
    '\t\trespond 404',
    '\t}',
    '}',
  ].join('\n').replace(/\t/g, '    ');
}

/** Quote for display in a POSIX shell. */
export function shellJoin(argv) {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

async function installFromNpx({ c, t, out, yn, runFn, env }) {
  // npx puts its own temporary copy first on PATH, so look in npm's global folder directly.
  const prefix = sys.npmGlobalPrefix(runFn);
  if (!prefix) {
    out.line(t('install.noNpm'));
    return null;
  }
  const binPath = join(prefix, 'bin', 'cctether');
  const describe = () => {
    const self = sys.locateSelf({ cliPath: binPath, env, runFn });
    return { kind: 'installed', binPath, cliPath: self.cliPath, onPath: sys.findOnPath('cctether', env, { skipNpx: true }) === binPath };
  };
  const existingVersion = sys.versionAt(binPath);
  if (existingVersion === c.version) {
    out.line(t('install.npx.found', { version: c.version, path: binPath }));
    const found = describe();
    if (!found.onPath) out.line(t('install.notOnPath', { dir: dirname(binPath) }));
    return found;
  }
  const ok = await yn(existingVersion
    ? t('install.npx.update', { old: existingVersion, path: binPath, version: c.version })
    : t('install.npx.ask', { version: c.version }), true);
  if (!ok) {
    out.line(t('install.declined'));
    return null;
  }
  if (!sys.npmPrefixWritable(prefix)) {
    out.line(t('install.noWrite', { dir: prefix, version: c.version }));
    return null;
  }
  out.line(t('install.running', { version: c.version }));
  const r = runFn('npm', ['install', '-g', `cctether@${c.version}`], { inherit: true, timeoutMs: 5 * 60_000 });
  if (r.status !== 0 || sys.versionAt(binPath) !== c.version) {
    out.line(t('install.failed', { code: r.status ?? '?' }));
    return null;
  }
  const installed = describe();
  out.line(t('install.done', { version: c.version, path: binPath }));
  if (!installed.onPath) out.line(t('install.notOnPath', { dir: dirname(binPath) }));
  return installed;
}

/**
 * Write and start the systemd user service. Returns { ok, managed }: managed means systemd now runs
 * this cctether; ok is false when something failed (a kept unit isn't a failure).
 */
async function installService({ c, t, out, yn, runFn, P, self, unitPath, cfg }) {
  const unitArgs = { nodePath: process.execPath, cliPath: self.cliPath, configDir: c.dir, socketPath: P.socket };
  let content;
  try {
    content = sys.renderUnit(unitArgs);
  } catch (e) {
    out.line(t('service.failed', { detail: e.message }));
    return { ok: false, managed: false };
  }
  let existing = null;
  try { existing = readFileSync(unitPath, 'utf8'); } catch {}
  const changed = existing !== content;
  if (existing !== null && changed) {
    // Replace without asking only a unit setup wrote for this same settings folder.
    const ours = existing.startsWith(sys.UNIT_HEADER);
    const otherDir = ours ? sys.unitConfigDir(existing) : null;
    if (!ours || (otherDir !== null && otherDir !== c.dir)) {
      const question = ours ? t('service.otherDir', { path: unitPath, dir: otherDir, current: c.dir }) : t('service.overwrite', { path: unitPath });
      if (!(await yn(question, false))) {
        out.line(t('service.kept', { path: unitPath }));
        return { ok: true, managed: false };
      }
    }
  }
  if (changed) {
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, content);
  }
  runFn('systemctl', ['--user', 'daemon-reload']);
  runFn('systemctl', ['--user', 'enable', sys.UNIT_NAME]);

  const active = sys.serviceActive(runFn);
  const st = await adminRequest(P.socket, { cmd: 'status' });
  const needsStart = !active || changed || st?.version !== c.version || !st?.ok || st.pid !== sys.serviceMainPid(runFn);
  if (needsStart) {
    // If Claude Code started a copy of the service, the one systemd starts takes over from it.
    let r = runFn('systemctl', ['--user', active ? 'restart' : 'start', sys.UNIT_NAME]);
    let up = r.status === 0 && await waitForManaged(P, cfg, runFn);
    if (!up && sys.serviceExitStatus(runFn) === 226) {
      // 226/NAMESPACE: this system doesn't allow the file-system sandbox for user services.
      writeFileSync(unitPath, sys.renderUnit({ ...unitArgs, sandbox: false }));
      runFn('systemctl', ['--user', 'daemon-reload']);
      runFn('systemctl', ['--user', 'reset-failed', sys.UNIT_NAME]);
      r = runFn('systemctl', ['--user', 'restart', sys.UNIT_NAME]);
      up = r.status === 0 && await waitForManaged(P, cfg, runFn);
    }
    if (!up) {
      const detail = (r.stderr || r.error?.message || '').trim().split('\n')[0] || `systemctl --user start ${sys.UNIT_NAME}`;
      out.line(t('service.failed', { detail }));
      return { ok: false, managed: false };
    }
  }
  out.line(t('service.ok'));
  const user = userInfo().username;
  if (sys.lingerEnabled(runFn, user)) out.line(t('service.linger.ok'));
  else if (sys.tryEnableLinger(runFn) && sys.lingerEnabled(runFn, user)) out.line(t('service.linger.enabled'));
  else out.line(t('service.linger.need', { user }));
  return { ok: true, managed: true };
}

/** Add cctether to Claude Code. Returns false if that failed. */
async function registerWithClaude({ t, out, yn, runFn, env, cmd, dir, customHome, yes }) {
  const wantEnv = customHome ? { CCTETHER_HOME: dir } : {};
  const current = sys.claudeRegistration(env);
  const same = (r) => r && r.command === cmd[0] && isDeepStrictEqual(r.args, cmd.slice(1))
    && (r.env?.CCTETHER_HOME ?? null) === (wantEnv.CCTETHER_HOME ?? null);
  if (same(current)) {
    out.line(t('claude.same'));
    return true;
  }
  const addArgs = ['mcp', 'add', '-s', 'user', 'cctether', ...(customHome ? ['-e', `CCTETHER_HOME=${dir}`] : []), '--', ...cmd];
  let r = runFn('claude', addArgs);
  if (r.status !== 0 && /already exists/i.test(r.stdout + r.stderr)) {
    const old = current ? shellJoin([current.command, ...current.args]) : '?';
    // Someone set this up differently on purpose, maybe: --yes never replaces it.
    if (yes) {
      out.line(t('claude.keptYes', { old, new: shellJoin(cmd) }));
      return true;
    }
    if (!(await yn(t('claude.replace', { old, new: shellJoin(cmd) }), true))) {
      out.line(t('claude.kept'));
      return true;
    }
    runFn('claude', ['mcp', 'remove', '-s', 'user', 'cctether']);
    r = runFn('claude', addArgs);
  }
  if (r.status === 0) {
    out.line(t('claude.added'));
    return true;
  }
  out.line(t('claude.failed', { detail: (r.stderr || r.stdout || r.error?.message || '').trim().split('\n')[0] }));
  return false;
}

/** Optionally tell Claude, in its personal CLAUDE.md, to use cctether for browser tasks by itself. */
async function claudeMdStep({ t, out, yn, env, opts }) {
  if (opts.claudeMd === false) return;
  const path = sys.claudeMdFile(env);
  let state;
  try {
    state = sys.findClaudeMdNote(sys.readClaudeMd(path)).state;
  } catch (e) {
    out.line(t('claude.mdFailed', { path, detail: e.message }));
    return;
  }
  if (state === 'ambiguous') {
    out.line(t('claude.mdAmbiguous', { path }));
    return;
  }
  // Someone emptied the note: they don't want it. Only --claude-md fills it again.
  if (state === 'empty' && opts.claudeMd !== true) return;
  // The note is cctether's own: refresh it if it's there; otherwise only add it when asked to.
  if (state === 'absent' && opts.claudeMd !== true) {
    if (opts.yes) {
      out.line(t('claude.mdHint'));
      return;
    }
    if (!(await yn(t('claude.mdAsk', { path }), true))) {
      out.line(t('claude.mdDeclined'));
      return;
    }
  }
  try {
    const r = sys.upsertClaudeMdNote(path, t('claude.mdBody'), t('claude.mdComment'), { force: opts.claudeMd === true });
    const key = { added: 'claude.mdAdded', updated: 'claude.mdUpdated', same: 'claude.mdSame', ambiguous: 'claude.mdAmbiguous' }[r];
    if (key) out.line(t(key, { path }));
  } catch (e) {
    out.line(t('claude.mdFailed', { path, detail: e.code === 'EACCES' || e.code === 'EPERM' ? t('claude.mdReadOnly') : e.message }));
  }
}

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(150);
  }
  return false;
}

async function waitForService(P, cfg, ms = 8000) {
  return waitFor(async () => {
    const st = await adminRequest(P.socket, { cmd: 'status' }, 1000);
    return !!st?.ok && st.port === cfg.port;
  }, ms);
}

/** Wait until the service answering is the one systemd runs (not a copy Claude Code started). */
async function waitForManaged(P, cfg, runFn, ms = 12_000) {
  return waitFor(async () => {
    const st = await adminRequest(P.socket, { cmd: 'status' }, 1000);
    return !!st?.ok && st.port === cfg.port && st.pid === sys.serviceMainPid(runFn);
  }, ms);
}

/** Make sure a service of this version runs on the configured port. Returns true when one answers. */
async function ensureRunning({ t, out, runFn, env, P, cfg, version, self, managed, startDaemon }) {
  let st = await adminRequest(P.socket, { cmd: 'status' });
  if (st?.ok && st.version === version && st.port === cfg.port) {
    out.line(t('check.service.up', { version: st.version, pid: st.pid }));
    return true;
  }
  const restarting = !!st?.ok;
  if (restarting && managed) runFn('systemctl', ['--user', 'restart', sys.UNIT_NAME]);
  else if (restarting && sys.serviceActive(runFn)) {
    // A service unit setup didn't write (or wasn't allowed to replace) runs it: don't fight it.
    out.line(t('check.service.up', { version: st.version, pid: st.pid }));
    if (st.version !== version) out.line(t('check.service.old', { running: st.version, version, how: 'systemctl --user restart cctether' }));
    if (st.port !== cfg.port) out.line(t('check.service.port', { running: st.port, port: cfg.port, how: 'systemctl --user restart cctether' }));
    return true;
  } else if (restarting) {
    await adminRequest(P.socket, { cmd: 'stop' });
    await waitFor(async () => !(await adminRequest(P.socket, { cmd: 'status' }, 500))?.ok, 5000);
    startDaemon(P, self.cliPath, env);
  } else if (!managed) startDaemon(P, self.cliPath, env);
  const up = await waitForService(P, cfg);
  st = up ? await adminRequest(P.socket, { cmd: 'status' }) : null;
  if (!st?.ok) {
    out.line(t('check.startFailed'));
    return false;
  }
  out.line(t(restarting ? 'check.restarted' : 'check.started', { version: st.version }));
  if (st.version !== version) out.line(t('check.service.old', { running: st.version, version, how: 'systemctl --user restart cctether' }));
  return true;
}

/** Try the local address and, if there is one, the public address. */
export async function checkUrls({ t, out, cfg, publicUrl }) {
  const extensionId = cfg.extensionIds[0];
  const local = localUrl(cfg);
  const results = { localOk: false, publicOk: false, publicReason: null };
  const r1 = await checkAddress({ url: local, key: cfg.key, extensionId, timeoutMs: 5000 });
  results.localOk = r1.ok;
  out.line(r1.ok ? t('check.ok.local', { url: local })
    : t('check.fail', { url: local, why: explainCheck(t, r1, { url: local, port: cfg.port, extensionId, local: true }) }));
  if (publicUrl) {
    const r2 = await checkAddress({ url: publicUrl, key: cfg.key, extensionId, timeoutMs: 10_000 });
    results.publicOk = r2.ok;
    results.publicReason = r2.ok ? null : r2.reason;
    out.line(r2.ok ? t('check.ok.public', { url: publicUrl })
      : t('check.fail', { url: publicUrl, why: explainCheck(t, r2, { url: publicUrl, port: cfg.port, extensionId, local: false }) }));
  }
  return results;
}

/** `cctether check` on its own. Returns the exit code: 0 all good, 1 a check failed, 3 not running. */
export async function runCheck({ dir, version, write, color, lang, env = process.env, runFn = sys.run }) {
  const style = createStyle(!!color);
  const t = createText(pickLanguage(lang, env), style);
  const out = createPrinter(write, style);
  const P = paths(dir, env);
  out.title(t('check.title'));
  out.blank();
  const cfg = loadConfig(dir);
  if (!cfg) {
    out.line(t('check.notSetUp'));
    out.blank();
    return 3;
  }
  const hasUnit = existsSync(sys.unitFile(env));
  const st = await adminRequest(P.socket, { cmd: 'status' });
  if (!st?.ok) {
    out.line(t('check.service.down', { how: hasUnit ? 'systemctl --user start cctether' : 'cctether daemon' }));
    out.blank();
    return 3;
  }
  out.line(t('check.service.up', { version: st.version, pid: st.pid }));
  const how = hasUnit && sys.serviceActive(runFn) ? 'systemctl --user restart cctether' : 'cctether stop';
  if (st.version !== version) out.line(t('check.service.old', { running: st.version, version, how }));
  if (st.port !== cfg.port) out.line(t('check.service.port', { running: st.port, port: cfg.port, how }));
  const publicUrl = cfg.publicUrl && !isLocalUrl(cfg.publicUrl) ? cfg.publicUrl : null;
  const r = await checkUrls({ t, out, cfg, publicUrl });
  if (publicUrl && !r.publicOk && r.localOk && HAIRPIN_REASONS.has(r.publicReason)) out.line(style.dim(t('check.hairpin')));
  const b = st.browser;
  if (b?.connected) out.line(t('check.browser.connected', { browser: b.info?.browser ?? '?', extension: b.info?.extension ?? '?' }));
  else out.line(t('check.browser.none'));
  out.blank();
  return r.localOk && (!publicUrl || r.publicOk) ? 0 : 1;
}

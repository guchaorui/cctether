// Configuration directory and config.json (SPEC §4.5).

import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, statSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 27182;
export const WS_PATH = '/cctether';
/** Extension IDs accepted by default: the unpacked build (fixed by the manifest key). */
export const DEFAULT_EXTENSION_IDS = ['nfebjhhcnoilmfjacolkofphfekkjioh'];

export function configDir(env = process.env) {
  if (env.CCTETHER_HOME) return env.CCTETHER_HOME;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'cctether');
  return join(homedir(), '.config', 'cctether');
}

/** Unix socket paths are limited to 104 (macOS) / 108 (Linux) bytes. */
const MAX_SOCKET_PATH = 100;

function isPrivateDir(d) {
  try {
    const st = statSync(d);
    return st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * The control socket lives in the config directory. If that path is too long for a Unix socket,
 * use the per-user runtime directory instead (private by definition, but checked anyway).
 */
export function socketPath(dir, env = process.env) {
  const p = join(dir, 'control.sock');
  if (Buffer.byteLength(p) <= MAX_SOCKET_PATH) return p;
  const rt = env.XDG_RUNTIME_DIR;
  if (rt && isPrivateDir(rt)) {
    const alt = join(rt, `cctether-${createHash('sha256').update(dir).digest('hex').slice(0, 16)}.sock`);
    if (Buffer.byteLength(alt) <= MAX_SOCKET_PATH) return alt;
  }
  return p; // too long: startControl explains what to do
}

export const paths = (dir, env = process.env) => ({
  dir,
  config: join(dir, 'config.json'),
  socket: socketPath(dir, env),
  log: join(dir, 'daemon.log'),
});

export class ConfigError extends Error {}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function validate(raw) {
  const cfg = {
    key: Buffer.from(String(raw.key ?? ''), 'base64url'),
    port: raw.port ?? DEFAULT_PORT,
    publicUrl: raw.publicUrl ?? null,
    extensionIds: raw.extensionIds ?? DEFAULT_EXTENSION_IDS,
    trustProxySetting: raw.trustProxy ?? null,
  };
  if (cfg.trustProxySetting !== null && typeof cfg.trustProxySetting !== 'boolean') {
    throw new ConfigError('config.json: "trustProxy" must be true, false or null.');
  }
  if (cfg.key.length !== 32) throw new ConfigError('config.json: "key" must be 32 bytes (base64url). Run `cctether rotate` to make a new one.');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new ConfigError('config.json: "port" must be 1-65535.');
  if (cfg.publicUrl !== null && !isValidServerUrl(cfg.publicUrl)) {
    throw new ConfigError('config.json: "publicUrl" must be a wss:// URL (or ws:// to 127.0.0.1 / localhost).');
  }
  if (!Array.isArray(cfg.extensionIds) || !cfg.extensionIds.every((id) => /^[a-p]{32}$/.test(id))) {
    throw new ConfigError('config.json: "extensionIds" must be a list of 32-letter extension IDs.');
  }
  return cfg;
}

export function isValidServerUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password || u.hash || u.search) return false;
  if (u.protocol === 'wss:') return true;
  return u.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}

/**
 * Whether to take the client address from X-Forwarded-For when the peer is this computer.
 * Default: yes when the public address is HTTPS on another host (that means a local reverse proxy
 * such as Caddy or cloudflared is in front), otherwise no. "trustProxy" in config.json overrides.
 */
export function trustProxy(cfg) {
  if (cfg.trustProxySetting !== null && cfg.trustProxySetting !== undefined) return cfg.trustProxySetting;
  if (!cfg.publicUrl) return false;
  const u = new URL(cfg.publicUrl);
  return u.protocol === 'wss:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
}

export function localUrl(cfg) {
  return `ws://127.0.0.1:${cfg.port}${WS_PATH}`;
}

/** The URL put into connection codes. */
export function serverUrl(cfg) {
  return cfg.publicUrl ?? localUrl(cfg);
}

export function loadConfig(dir) {
  const p = paths(dir).config;
  if (!existsSync(p)) return null;
  const st = statSync(p);
  if (st.mode & 0o077) chmodSync(p, 0o600); // never leave the key readable by others
  let raw;
  try {
    raw = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new ConfigError(`Can't read ${p}: ${e.message}`);
  }
  return validate(raw);
}

export function saveConfig(dir, cfg) {
  ensureDir(dir);
  const p = paths(dir).config;
  const tmp = `${p}.${process.pid}.tmp`;
  const data = {
    version: 1,
    key: cfg.key.toString('base64url'),
    port: cfg.port,
    publicUrl: cfg.publicUrl,
    extensionIds: cfg.extensionIds,
    trustProxy: cfg.trustProxySetting ?? null,
  };
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

export function newKey() {
  return randomBytes(32);
}

/** Create config.json if it doesn't exist. Returns { cfg, created }. */
export function initConfig(dir, { port, publicUrl } = {}) {
  const existing = loadConfig(dir);
  if (existing) return { cfg: existing, created: false };
  const cfg = validate({
    key: newKey().toString('base64url'),
    port: port ?? DEFAULT_PORT,
    publicUrl: publicUrl ?? null,
    extensionIds: DEFAULT_EXTENSION_IDS,
  });
  saveConfig(dir, cfg);
  return { cfg, created: true };
}

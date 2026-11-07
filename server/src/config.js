// Configuration directory and config.json (SPEC §4.5).

import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, statSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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

export const paths = (dir) => ({
  dir,
  config: join(dir, 'config.json'),
  socket: join(dir, 'control.sock'),
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
  };
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

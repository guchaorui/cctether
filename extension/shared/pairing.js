// Connection code ("pairing code") parsing. Format:
//   cctether1:<base64url(JSON {"u": "<ws or wss URL>", "k": "<base64url 32-byte key>"})>
// The server-side encoder lives in server/src/pairing.js; keep both in sync.

export const CODE_PREFIX = 'cctether1:';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function base64urlToBytes(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Is this server URL acceptable? wss:// anywhere; ws:// only to this computer (D7).
 * @returns {'ok'|'invalid'|'insecure'}
 */
export function checkServerUrl(url) {
  let u;
  try { u = new URL(url); } catch { return 'invalid'; }
  if (u.username || u.password || u.hash) return 'invalid';
  if (u.protocol === 'wss:') return 'ok';
  if (u.protocol === 'ws:') return LOOPBACK_HOSTS.has(u.hostname) ? 'ok' : 'insecure';
  return 'invalid';
}

/** Short display form of a server URL: host[:port] plus the path when it isn't the default. */
export function displayServer(url) {
  try {
    const u = new URL(url);
    return u.host + (u.pathname && u.pathname !== '/' && u.pathname !== '/cctether' ? u.pathname : '');
  } catch {
    return url;
  }
}

/**
 * Parse a connection code.
 * @returns {{ ok: true, url: string, key: Uint8Array } | { ok: false, error: 'invalid_code'|'insecure_url' }}
 */
export function parsePairingCode(text) {
  if (typeof text !== 'string') return { ok: false, error: 'invalid_code' };
  const code = text.replace(/\s+/g, '');
  if (!code.startsWith(CODE_PREFIX) || code.length > 4096) return { ok: false, error: 'invalid_code' };
  let obj;
  try {
    obj = JSON.parse(new TextDecoder().decode(base64urlToBytes(code.slice(CODE_PREFIX.length))));
  } catch {
    return { ok: false, error: 'invalid_code' };
  }
  if (!obj || typeof obj !== 'object' || typeof obj.u !== 'string' || typeof obj.k !== 'string') {
    return { ok: false, error: 'invalid_code' };
  }
  let key;
  try { key = base64urlToBytes(obj.k); } catch { return { ok: false, error: 'invalid_code' }; }
  if (key.length !== 32) return { ok: false, error: 'invalid_code' };
  const check = checkServerUrl(obj.u);
  if (check === 'invalid') return { ok: false, error: 'invalid_code' };
  if (check === 'insecure') return { ok: false, error: 'insecure_url' };
  return { ok: true, url: obj.u, key };
}

/** 8 hex chars of SHA-256(key). Identifies a key without revealing it. */
export async function keyFingerprint(keyBytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytes));
  return [...h.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Connection codes: "cctether1:" + base64url(JSON {"u": url, "k": base64url key}).
// The extension's parser is extension/shared/pairing.js; keep both in sync.

import { createHash } from 'node:crypto';

export const CODE_PREFIX = 'cctether1:';

export function encodePairingCode(url, key) {
  const payload = JSON.stringify({ u: url, k: Buffer.from(key).toString('base64url') });
  return CODE_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

/** Used by tests and diagnostics. Returns { url, key } or null. */
export function decodePairingCode(code) {
  if (typeof code !== 'string' || !code.startsWith(CODE_PREFIX)) return null;
  try {
    const obj = JSON.parse(Buffer.from(code.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
    const key = Buffer.from(obj.k, 'base64url');
    if (typeof obj.u !== 'string' || key.length !== 32) return null;
    return { url: obj.u, key };
  } catch {
    return null;
  }
}

/** 8 hex chars of SHA-256(key): identifies a key without revealing it. */
export function keyFingerprint(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

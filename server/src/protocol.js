// Wire protocol between the extension and the daemon (SPEC §4.4).
//
// Handshake (JSON text frames):
//   ext → srv  { t: 'hello', proto, cn }                      cn = 32 random bytes, base64url
//   srv → ext  { t: 'challenge', proto, sn, sp }              sp = HMAC(K, "cctether/1 server" | cn | sn)
//   ext → srv  { t: 'auth', cp }                              cp = HMAC(K, "cctether/1 client" | cn | sn)
// After that every frame is binary: AES-256-GCM(JSON), one key per direction derived with
// HKDF-SHA256(K, salt = cn | sn, info = "cctether/1 c2s" | "cctether/1 s2c"); the 96-bit IV is
// 4 zero bytes + a 64-bit big-endian message counter, so lost, replayed or reordered frames fail.

import { createHmac, hkdfSync, createCipheriv, createDecipheriv, timingSafeEqual, randomBytes } from 'node:crypto';

export const PROTO = 1;
export const LABEL_SERVER = 'cctether/1 server';
export const LABEL_CLIENT = 'cctether/1 client';
export const INFO_C2S = 'cctether/1 c2s';
export const INFO_S2C = 'cctether/1 s2c';
export const NONCE_BYTES = 32;

/** Max frame sizes (SPEC §4.4). */
export const MAX_FROM_EXTENSION = 32 * 1024 * 1024;
export const MAX_TO_EXTENSION = 1024 * 1024;
export const HANDSHAKE_TIMEOUT_MS = 5000;
export const IDLE_TIMEOUT_MS = 60000;

/** WebSocket close codes (4000-4999 are application-defined). */
export const CLOSE = {
  protocolError: 4400,
  authFailed: 4401,
  originRejected: 4403,
  versionMismatch: 4426,
  replaced: 4409,
  timeout: 4408,
  keyChanged: 4410,
  shutdown: 4503,
};

export function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Decode base64url strictly; returns null when malformed or the wrong length. */
export function fromB64u(s, expectedLength) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64url');
  if (expectedLength !== undefined && buf.length !== expectedLength) return null;
  // Reject non-canonical encodings (e.g. trailing bits set) so one value has one spelling.
  if (buf.toString('base64url') !== s) return null;
  return buf;
}

export function newNonce() {
  return randomBytes(NONCE_BYTES);
}

export function proof(key, label, cn, sn) {
  return createHmac('sha256', key).update(label).update(cn).update(sn).digest();
}

export function proofMatches(expected, actual) {
  return Buffer.isBuffer(actual) && actual.length === expected.length && timingSafeEqual(expected, actual);
}

export function deriveSessionKeys(key, cn, sn) {
  const salt = Buffer.concat([cn, sn]);
  return {
    c2s: Buffer.from(hkdfSync('sha256', key, salt, INFO_C2S, 32)),
    s2c: Buffer.from(hkdfSync('sha256', key, salt, INFO_S2C, 32)),
  };
}

function ivFor(counter) {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(counter, 4);
  return iv;
}

/** Encrypts outgoing and decrypts incoming frames for one direction pair. */
export class SessionCipher {
  #sendKey;
  #recvKey;
  #sendCounter = 0n;
  #recvCounter = 0n;

  constructor(sendKey, recvKey) {
    this.#sendKey = sendKey;
    this.#recvKey = recvKey;
  }

  /** @returns {Buffer} ciphertext || 16-byte tag */
  seal(obj) {
    const plain = Buffer.from(JSON.stringify(obj), 'utf8');
    const c = createCipheriv('aes-256-gcm', this.#sendKey, ivFor(this.#sendCounter++));
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  }

  /** @returns {object} parsed message; throws on any authentication or parse failure */
  open(frame) {
    if (!Buffer.isBuffer(frame) || frame.length < 16) throw new Error('short frame');
    const d = createDecipheriv('aes-256-gcm', this.#recvKey, ivFor(this.#recvCounter++));
    d.setAuthTag(frame.subarray(frame.length - 16));
    const plain = Buffer.concat([d.update(frame.subarray(0, frame.length - 16)), d.final()]);
    const msg = JSON.parse(plain.toString('utf8'));
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') throw new Error('bad message');
    return msg;
  }
}

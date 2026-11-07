// Handshake proofs and per-message encryption (SPEC §4.4), using WebCrypto.
// Must stay byte-compatible with server/src/protocol.js (tested in server/test/interop.test.js).

export const PROTO = 1;
const LABEL_SERVER = 'cctether/1 server';
const LABEL_CLIENT = 'cctether/1 client';
const INFO_C2S = 'cctether/1 c2s';
const INFO_S2C = 'cctether/1 s2c';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function randomNonce() {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** @param {Uint8Array} keyBytes 32-byte shared key */
export async function importSharedKey(keyBytes) {
  const [hmac, hkdf] = await Promise.all([
    crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
    crypto.subtle.importKey('raw', keyBytes, 'HKDF', false, ['deriveKey']),
  ]);
  return { hmac, hkdf };
}

/** Our proof: HMAC(K, "cctether/1 client" | cn | sn). */
export async function clientProof(keys, cn, sn) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', keys.hmac, concat(enc.encode(LABEL_CLIENT), cn, sn)));
}

/** Check the server's proof (constant-time comparison inside WebCrypto). */
export async function verifyServerProof(keys, cn, sn, sp) {
  if (!(sp instanceof Uint8Array) || sp.length !== 32) return false;
  return crypto.subtle.verify('HMAC', keys.hmac, sp, concat(enc.encode(LABEL_SERVER), cn, sn));
}

function ivFor(counter) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, counter);
  return iv;
}

/**
 * Session cipher for the extension side: encrypts client→server, decrypts server→client.
 * seal/open each take their counter synchronously at call time, so callers must call them in
 * wire order (the connection serialises sends and receives).
 */
export async function createSessionCipher(keys, cn, sn) {
  const salt = concat(cn, sn);
  const derive = (info, usage) => crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) },
    keys.hkdf, { name: 'AES-GCM', length: 256 }, false, [usage],
  );
  const [sendKey, recvKey] = await Promise.all([derive(INFO_C2S, 'encrypt'), derive(INFO_S2C, 'decrypt')]);
  let sendCounter = 0n;
  let recvCounter = 0n;
  return {
    /** @returns {Promise<ArrayBuffer>} ciphertext with the 16-byte tag appended */
    seal(text) {
      return crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivFor(sendCounter++) }, sendKey, enc.encode(text));
    },
    /** @returns {Promise<object>} throws if the frame is forged, replayed, reordered or malformed */
    async open(buf) {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivFor(recvCounter++) }, recvKey, buf);
      const msg = JSON.parse(dec.decode(plain));
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') throw new Error('bad message');
      return msg;
    },
  };
}

// The connection to the cctether server: handshake, encryption, heartbeat, reconnects (SPEC §4.4).
// No chrome.* APIs in here, so it can be tested in Node against the real server.

import { PROTO, randomNonce, importSharedKey, clientProof, verifyServerProof, createSessionCipher } from './crypto.js';
import { checkServerUrl, displayServer, base64urlToBytes, bytesToBase64url } from '../shared/pairing.js';

const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 20_000;
const PONG_TIMEOUT_MS = 45_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];
/** Errors that retrying soon won't fix (wrong key, wrong version, blocked): retry rarely. */
const SLOW_RETRY_MS = 5 * 60_000;
const SLOW_ERRORS = new Set(['server_auth_failed', 'auth_rejected', 'origin_rejected', 'update_extension', 'update_server', 'rate_limited']);
const SERVER_ERRORS = new Set(['auth_rejected', 'origin_rejected', 'update_extension', 'update_server', 'rate_limited']);
/** Messages above this many characters are sent as fragments (frames must stay under 1 MB). */
const FRAG_CHARS = 120_000;
const MAX_MESSAGE_CHARS = 30 * 1024 * 1024;

const CLOSE_CODE_ERRORS = { 4401: 'auth_rejected', 4403: 'origin_rejected', 4409: 'replaced', 4408: 'timeout' };

/**
 * @typedef {object} ConnectionOptions
 * @property {(patch: object) => void} onStatus   receives partial Status updates (see shared/contract.js)
 * @property {(tool: string, args: object) => Promise<{ok: true, data: any}|{ok: false, error: {code: string, message: string}}>} onCall
 * @property {() => object} getInfo               { extension, browser, platform } sent after connecting
 * @property {(connected: boolean) => void} [onConnectedChange]
 * @property {(url: string) => any} [createSocket]
 * @property {(msg: string) => void} [log]
 */
export class Connection {
  #o;
  #pairing = null; // { url, key: Uint8Array }
  #keys = null;
  #ws = null;
  #gen = 0;
  #phase = 'idle'; // idle | opening | hello | auth | connected | down
  #attempt = 0;
  #retryAt = null;
  #retryTimer = null;
  #hsTimer = null;
  #hbTimer = null;
  #lastPong = 0;
  #cipher = null;
  #sendChain = Promise.resolve();
  #recvChain = Promise.resolve();

  /** @param {ConnectionOptions} opts */
  constructor(opts) {
    this.#o = { createSocket: (url) => new WebSocket(url), log: () => {}, onConnectedChange: () => {}, ...opts };
  }

  get connected() {
    return this.#phase === 'connected';
  }

  /**
   * Use this pairing and connect (or wait until retryAt).
   * @param {{ url: string, key: Uint8Array }} pairing
   * @param {{ retryAt?: number|null, replaced?: boolean }} [resume]  state restored after a service-worker restart
   */
  start(pairing, resume = {}) {
    this.#teardown();
    this.#pairing = pairing;
    this.#keys = null;
    this.#attempt = 0;
    const server = displayServer(pairing.url);
    if (resume.replaced) {
      this.#phase = 'down';
      this.#o.onStatus({ conn: 'replaced', server, error: null, retryAt: null });
      return;
    }
    if (resume.retryAt && resume.retryAt > Date.now()) {
      this.#phase = 'down';
      this.#schedule(resume.retryAt - Date.now());
      this.#o.onStatus({ server, retryAt: this.#retryAt });
      return;
    }
    this.#connect();
  }

  /** Forget the pairing and disconnect. */
  stop() {
    this.#teardown();
    this.#pairing = null;
    this.#keys = null;
    this.#phase = 'idle';
    this.#o.onStatus({ conn: 'unpaired', server: null, error: null, retryAt: null, serverVersion: null });
  }

  /** Connect now, resetting the backoff (the user pressed "reconnect", or the network came back). */
  reconnectNow() {
    if (!this.#pairing) return;
    this.#attempt = 0;
    this.#teardown();
    this.#connect();
  }

  /** Called periodically (chrome.alarms): reconnect if a retry is due, check the heartbeat. */
  tick() {
    if (!this.#pairing) return;
    if (this.#phase === 'down' && this.#retryAt !== null && this.#retryAt <= Date.now()) this.#connect();
    else if (this.#phase === 'connected') this.#heartbeat(this.#gen);
  }

  // --- internals -------------------------------------------------------------------------

  #setStatus(patch) {
    this.#o.onStatus(patch);
  }

  #schedule(delayMs) {
    clearTimeout(this.#retryTimer);
    this.#retryAt = Date.now() + delayMs;
    this.#retryTimer = setTimeout(() => {
      if (this.#phase === 'down' && this.#pairing) this.#connect();
    }, delayMs);
  }

  #teardown() {
    const wasConnected = this.#phase === 'connected';
    this.#gen++;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#hsTimer);
    clearInterval(this.#hbTimer);
    this.#retryTimer = this.#hsTimer = this.#hbTimer = null;
    this.#retryAt = null;
    this.#cipher = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch {}
    }
    if (wasConnected) this.#o.onConnectedChange(false);
  }

  #connect() {
    this.#teardown();
    const gen = this.#gen;
    const { url, key } = this.#pairing;
    const server = displayServer(url);
    if (checkServerUrl(url) !== 'ok') return this.#down(gen, 'insecure_url');

    this.#phase = 'opening';
    this.#setStatus({ conn: 'connecting', server, retryAt: null });
    let ws;
    try {
      ws = this.#o.createSocket(url);
    } catch (e) {
      return this.#down(gen, 'unreachable', e.message);
    }
    this.#ws = ws;
    ws.binaryType = 'arraybuffer';
    const cn = randomNonce();
    let opened = false;
    this.#hsTimer = setTimeout(() => this.#down(gen, opened ? 'timeout' : 'unreachable'), HANDSHAKE_TIMEOUT_MS);

    // Everything goes through one chain so handshake steps, decryption and the final close are
    // processed strictly in arrival order.
    const enqueue = (fn) => {
      this.#recvChain = this.#recvChain.then(() => (gen === this.#gen ? fn() : undefined)).catch((e) => {
        this.#o.log(`connection error: ${e?.message ?? e}`);
        this.#down(gen, 'protocol_error');
      });
    };

    ws.onopen = () => {
      if (gen !== this.#gen) return;
      opened = true;
      this.#phase = 'hello';
      ws.send(JSON.stringify({ t: 'hello', proto: PROTO, cn: bytesToBase64url(cn) }));
    };
    ws.onmessage = (ev) => {
      if (gen !== this.#gen) return;
      if (typeof ev.data === 'string') enqueue(() => this.#onText(gen, ev.data, cn, key));
      else enqueue(() => this.#onBinary(gen, ev.data));
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (gen !== this.#gen) return;
      enqueue(() => {
        const mapped = CLOSE_CODE_ERRORS[ev.code];
        if (this.#phase === 'connected') this.#down(gen, mapped ?? 'closed');
        else this.#down(gen, mapped ?? (opened ? 'closed' : 'unreachable'));
      });
    };
  }

  async #onText(gen, data, cn, key) {
    let m;
    try { m = JSON.parse(data); } catch { return this.#down(gen, 'protocol_error'); }
    if (m?.t === 'error') return this.#down(gen, SERVER_ERRORS.has(m.code) ? m.code : 'protocol_error');
    if (m?.t !== 'challenge' || this.#phase !== 'hello') return this.#down(gen, 'protocol_error');
    if (m.proto !== PROTO) return this.#down(gen, typeof m.proto === 'number' && m.proto > PROTO ? 'update_extension' : 'update_server');
    let sn, sp;
    try {
      sn = base64urlToBytes(m.sn);
      sp = base64urlToBytes(m.sp);
    } catch {
      return this.#down(gen, 'protocol_error');
    }
    if (sn.length !== 32 || sp.length !== 32) return this.#down(gen, 'protocol_error');
    this.#keys ??= await importSharedKey(key);
    // D8: the server must prove it knows the key before we do anything it says.
    if (!(await verifyServerProof(this.#keys, cn, sn, sp))) return this.#down(gen, 'server_auth_failed');
    const cp = await clientProof(this.#keys, cn, sn);
    const cipher = await createSessionCipher(this.#keys, cn, sn);
    if (gen !== this.#gen) return;
    this.#cipher = cipher;
    this.#phase = 'auth';
    this.#ws.send(JSON.stringify({ t: 'auth', cp: bytesToBase64url(cp) }));
  }

  async #onBinary(gen, buf) {
    if (!this.#cipher || (this.#phase !== 'auth' && this.#phase !== 'connected')) return this.#down(gen, 'protocol_error');
    let m;
    try {
      m = await this.#cipher.open(buf);
    } catch {
      return this.#down(gen, 'protocol_error');
    }
    if (gen !== this.#gen) return;

    if (this.#phase === 'auth') {
      if (m.t !== 'welcome') return this.#down(gen, 'protocol_error');
      clearTimeout(this.#hsTimer);
      this.#phase = 'connected';
      this.#attempt = 0;
      this.#lastPong = Date.now();
      this.#setStatus({
        conn: 'connected', error: null, retryAt: null,
        serverVersion: typeof m.server === 'string' ? m.server.slice(0, 20) : null,
      });
      this.#send(gen, { t: 'info', ...this.#o.getInfo() });
      this.#hbTimer = setInterval(() => this.#heartbeat(gen), HEARTBEAT_MS);
      this.#o.onConnectedChange(true);
      return;
    }

    switch (m.t) {
      case 'pong':
        this.#lastPong = Date.now();
        break;
      case 'call':
        // Calls run concurrently; don't block the receive chain.
        this.#handleCall(gen, m);
        break;
      case 'bye':
        this.#o.log(`server said bye: ${m.reason}`);
        if (m.reason === 'replaced') return this.#down(gen, 'replaced');
        if (m.reason === 'key_changed') return this.#down(gen, 'closed', null, 0);
        return this.#down(gen, 'closed');
      default:
        break; // newer servers may send optional messages
    }
  }

  async #handleCall(gen, m) {
    if (!Number.isSafeInteger(m.id)) return;
    let result;
    if (typeof m.tool !== 'string' || !m.args || typeof m.args !== 'object' || Array.isArray(m.args)) {
      result = { ok: false, error: { code: 'bad_args', message: 'Malformed call.' } };
    } else {
      try {
        result = await this.#o.onCall(m.tool, m.args);
      } catch (e) {
        result = { ok: false, error: { code: 'internal', message: `Unexpected extension error: ${e?.message ?? e}` } };
      }
    }
    if (gen !== this.#gen) return;
    this.#send(gen, { t: 'result', id: m.id, ...result });
  }

  #heartbeat(gen) {
    if (gen !== this.#gen || this.#phase !== 'connected') return;
    if (Date.now() - this.#lastPong > PONG_TIMEOUT_MS) return this.#down(gen, 'timeout');
    this.#send(gen, { t: 'ping' });
  }

  /** Encrypt and send, splitting big messages into fragments; keeps wire order. */
  #send(gen, obj) {
    let text = JSON.stringify(obj);
    if (text.length > MAX_MESSAGE_CHARS && obj.t === 'result') {
      text = JSON.stringify({
        t: 'result', id: obj.id, ok: false,
        error: { code: 'too_large', message: `The result is too large to send (${Math.round(text.length / 1048576)} MB). Ask for less, e.g. a smaller screenshot or a narrower selector.` },
      });
    }
    const pieces = [];
    if (text.length <= FRAG_CHARS) pieces.push(text);
    else {
      for (let i = 0; i < text.length; i += FRAG_CHARS) {
        const last = i + FRAG_CHARS >= text.length;
        pieces.push(JSON.stringify(last ? { t: 'frag', s: text.slice(i, i + FRAG_CHARS), end: true } : { t: 'frag', s: text.slice(i, i + FRAG_CHARS) }));
      }
    }
    const cipher = this.#cipher;
    const ws = this.#ws;
    for (const p of pieces) {
      this.#sendChain = this.#sendChain.then(async () => {
        if (gen !== this.#gen || !cipher) return;
        const frame = await cipher.seal(p);
        if (gen === this.#gen && ws.readyState === 1) ws.send(frame);
      }).catch((e) => this.#o.log(`send failed: ${e?.message ?? e}`));
    }
  }

  /** The connection is gone (or failed): report why and plan the next attempt. */
  #down(gen, code, detail = null, delayOverride = null) {
    if (gen !== this.#gen) return;
    this.#teardown();
    this.#phase = 'down';
    if (code === 'replaced') {
      this.#setStatus({ conn: 'replaced', error: null, retryAt: null });
      return;
    }
    if (code === 'insecure_url') {
      this.#setStatus({ conn: 'disconnected', error: { code }, retryAt: null });
      return;
    }
    const delay = delayOverride ?? (SLOW_ERRORS.has(code) ? SLOW_RETRY_MS : BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)]);
    this.#attempt++;
    this.#schedule(delay);
    this.#setStatus({ conn: 'disconnected', error: detail ? { code, detail: String(detail).slice(0, 200) } : { code }, retryAt: this.#retryAt });
  }
}

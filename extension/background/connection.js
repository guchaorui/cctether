// The connection to the cctether server: handshake, encryption, heartbeat, reconnects (SPEC §4.4).
// No chrome.* APIs in here, so it can be tested in Node against the real server.

import { PROTO, randomNonce, importSharedKey, clientProof, verifyServerProof, createSessionCipher } from './crypto.js';
import { checkServerUrl, displayServer, base64urlToBytes, bytesToBase64url } from '../shared/pairing.js';

const HANDSHAKE_TIMEOUT_MS = 10_000;
/** A ping every 10 s keeps the service worker alive and notices a dead link within ~20 s. */
const HEARTBEAT_MS = 10_000;
const PONG_TIMEOUT_MS = 10_000;
/**
 * Extension service workers don't reliably get 'offline' / 'online' events (seen with Chrome's
 * network emulation: navigator.onLine changes, no event fires), so the flag is also read every second.
 */
const NET_CHECK_MS = 1000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];
/** Errors that retrying soon won't fix (wrong key, wrong version, blocked): retry rarely. */
const SLOW_RETRY_MS = 5 * 60_000;
const SLOW_ERRORS = new Set(['server_auth_failed', 'auth_rejected', 'origin_rejected', 'update_extension', 'update_server', 'rate_limited']);
const SERVER_ERRORS = new Set(['auth_rejected', 'origin_rejected', 'update_extension', 'update_server', 'rate_limited']);
/** States where "the network is back" must not trigger a reconnect. */
const NO_AUTO_RECONNECT = new Set(['replaced', 'insecure_url', ...SLOW_ERRORS]);
/** Messages above this many characters are sent as fragments (frames must stay under 1 MB). */
const FRAG_CHARS = 120_000;
const MAX_MESSAGE_BYTES = 30 * 1024 * 1024;

// What the server may send (SPEC §4.4): frames of at most 1 MiB. A bigger message comes as
// fragments { t: 'frag', i, n, s }, for upload_file only: in order, only pongs between them, at
// most MAX_FRAGMENTS of them and MAX_FRAGMENTED bytes of frames, within FRAG_TIME_MS.
const MAX_FRAME = 1024 * 1024;
const MAX_HANDSHAKE_TEXT = 4096;
const MAX_FRAGMENTS = 2200;
const MAX_FRAGMENTED = 32 * 1024 * 1024;
const FRAG_TIME_MS = 5 * 60_000;
/** Frames waiting to be decrypted, in bytes: more than one fragmented message's worth is wrong. */
const MAX_QUEUED = MAX_FRAGMENTED + 2 * MAX_FRAME;
/** For tests: must equal the service's (server/src/protocol.js). */
export const FRAGMENT_LIMITS = Object.freeze({ MAX_FRAGMENTS, MAX_FRAGMENTED, MAX_FRAME });
const utf8Length = (text) => (text.length * 3 <= MAX_MESSAGE_BYTES ? text.length : new TextEncoder().encode(text).length);

const CLOSE_CODE_ERRORS = { 4401: 'auth_rejected', 4403: 'origin_rejected', 4409: 'replaced', 4408: 'timeout' };

/**
 * @typedef {object} ConnectionOptions
 * @property {(patch: object) => void} onStatus   receives partial Status updates (see shared/contract.js)
 * @property {(tool: string, args: object, ctx: { live: () => boolean, cancelled: () => boolean }) => Promise<{ok: true, data: any}|{ok: false, error: {code: string, message: string}}>} onCall
 *   ctx.live(): whether the connection the call came on is still up (else its result can't be sent);
 *   ctx.cancelled(): whether the server said the client cancelled it
 * @property {() => object} getInfo               { extension, browser, platform } sent after connecting
 * @property {(connected: boolean) => void} [onConnectedChange]
 * @property {(url: string) => any} [createSocket]
 * @property {(msg: string) => void} [log]
 * @property {() => boolean} [isOnline]          false when the computer has no network (navigator.onLine)
 * @property {number} [heartbeatMs]
 * @property {number} [pongTimeoutMs]
 * @property {number} [netCheckMs]               how often to read isOnline(); 0 = never
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
  #pongTimer = null;
  #downCode = null; // why we are down (ErrorCode or 'replaced')
  #waitingForNetwork = false;
  #netTimer = null;
  #cipher = null;
  #sendChain = Promise.resolve();
  #recvChain = Promise.resolve();
  /** Bytes of frames received and not yet processed. */
  #queued = 0;
  /** A fragmented message arriving: { n, parts: string[], bytes, timer }. */
  #frag = null;
  /** Ids of calls running now, and those of them the server has said are cancelled. */
  #running = new Set();
  #cancelled = new Set();

  /** @param {ConnectionOptions} opts */
  constructor(opts) {
    this.#o = {
      createSocket: (url) => new WebSocket(url),
      log: () => {},
      onConnectedChange: () => {},
      isOnline: () => globalThis.navigator?.onLine !== false,
      heartbeatMs: HEARTBEAT_MS,
      pongTimeoutMs: PONG_TIMEOUT_MS,
      netCheckMs: NET_CHECK_MS,
      ...opts,
    };
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
    this.#watchNetwork(true);
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
    this.#watchNetwork(false);
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
    if (this.#phase === 'down' && this.#waitingForNetwork) {
      if (this.#o.isOnline()) this.reconnectNow(); // missed the 'online' event
    } else if (this.#phase === 'down' && this.#retryAt !== null && this.#retryAt <= Date.now()) this.#connect();
    else if (this.#phase === 'connected') this.#heartbeat(this.#gen);
  }

  /** The computer lost its network (browser 'offline' event): say so at once instead of waiting for the heartbeat. */
  networkLost() {
    if (!this.#pairing || this.#phase === 'idle') return;
    if (this.#phase === 'down' && (this.#waitingForNetwork || this.#downCode === 'replaced' || this.#downCode === 'insecure_url')) return;
    this.#down(this.#gen, 'offline');
  }

  /** The network is back (browser 'online' event): reconnect now, unless waiting is deliberate. */
  networkBack() {
    if (!this.#pairing || this.#phase !== 'down') return;
    if (this.#waitingForNetwork || !NO_AUTO_RECONNECT.has(this.#downCode)) this.reconnectNow();
  }

  // --- internals -------------------------------------------------------------------------

  #watchNetwork(on) {
    clearInterval(this.#netTimer);
    this.#netTimer = null;
    if (!on || !this.#o.netCheckMs) return;
    this.#netTimer = setInterval(() => {
      if (this.#o.isOnline()) {
        if (this.#waitingForNetwork) this.networkBack();
      } else if (!this.#waitingForNetwork) this.networkLost();
    }, this.#o.netCheckMs);
    this.#netTimer?.unref?.(); // Node (tests): don't keep the process alive
  }

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
    clearTimeout(this.#pongTimer);
    this.#retryTimer = this.#hsTimer = this.#hbTimer = this.#pongTimer = null;
    this.#retryAt = null;
    this.#waitingForNetwork = false;
    this.#cipher = null;
    this.#queued = 0;
    this.#dropFragments();
    this.#running.clear();
    this.#cancelled.clear();
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
      // Sizes are checked before anything is queued or decrypted.
      if (typeof ev.data === 'string') {
        if (ev.data.length > MAX_HANDSHAKE_TEXT) return this.#down(gen, 'protocol_error');
        enqueue(() => this.#onText(gen, ev.data, cn, key));
        return;
      }
      const size = ev.data.byteLength;
      if (!(size <= MAX_FRAME) || this.#queued + size > MAX_QUEUED) {
        this.#o.log('connection error: a frame from the server is too large');
        return this.#down(gen, 'protocol_error');
      }
      this.#queued += size;
      enqueue(() => {
        this.#queued -= size;
        return this.#onBinary(gen, ev.data);
      });
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
    // Any authenticated frame shows the link works: while a big message trickles in on a slow
    // link, a pong may come late behind its fragments.
    if (this.#phase === 'connected' && this.#pongTimer) {
      clearTimeout(this.#pongTimer);
      this.#pongTimer = null;
    }

    if (this.#phase === 'auth') {
      if (m.t !== 'welcome') return this.#down(gen, 'protocol_error');
      clearTimeout(this.#hsTimer);
      this.#phase = 'connected';
      this.#attempt = 0;
      this.#hbTimer = setInterval(() => this.#heartbeat(gen), this.#o.heartbeatMs);
      // frag: this extension takes fragmented messages from the server (upload_file).
      this.#send(gen, { t: 'info', ...this.#o.getInfo(), frag: true });
      this.#setStatus({
        conn: 'connected', error: null, retryAt: null,
        serverVersion: typeof m.server === 'string' ? m.server.slice(0, 20) : null,
      });
      // The status callback may have stopped or restarted the connection.
      if (gen === this.#gen) this.#o.onConnectedChange(true);
      return;
    }

    if (m.t === 'frag') {
      m = this.#onFragment(gen, m, buf.byteLength);
      if (!m) return;
    } else if (this.#frag && m.t !== 'pong') {
      return this.#protocolError(gen, 'another message in the middle of a fragmented one');
    }

    switch (m.t) {
      case 'pong':
        break;
      case 'call':
        // Calls run concurrently; don't block the receive chain.
        this.#handleCall(gen, m);
        break;
      case 'cancel':
        // The client gave up on this call (only upload_file acts on it, before giving the files).
        if (this.#running.has(m.id)) this.#cancelled.add(m.id);
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

  #protocolError(gen, why) {
    this.#o.log(`connection error: ${why}`);
    this.#down(gen, 'protocol_error');
  }

  #dropFragments() {
    if (this.#frag) clearTimeout(this.#frag.timer);
    this.#frag = null;
  }

  /**
   * One fragment of a big message: checked against what came before. Returns the whole message
   * once its last fragment is in, else null. Anything out of order breaks the connection.
   */
  #onFragment(gen, m, size) {
    const bad = (why) => { this.#protocolError(gen, `bad fragment (${why})`); return null; };
    if (typeof m.s !== 'string' || !Number.isSafeInteger(m.i) || !Number.isSafeInteger(m.n)) return bad('fields');
    let f = this.#frag;
    if (!f) {
      if (m.i !== 0 || m.n < 2 || m.n > MAX_FRAGMENTS) return bad('start');
      f = this.#frag = { n: m.n, parts: [], bytes: 0, timer: setTimeout(() => this.#protocolError(gen, 'fragmented message took too long'), FRAG_TIME_MS) };
    } else if (m.n !== f.n || m.i !== f.parts.length) return bad('order');
    f.bytes += size;
    if (f.bytes > MAX_FRAGMENTED) return bad('too large');
    f.parts.push(m.s);
    if (m.i < f.n - 1) return null;
    const text = f.parts.join('');
    f.parts = null; // only the joined text from here on
    this.#dropFragments();
    let whole;
    try { whole = JSON.parse(text); } catch { return bad('not JSON'); }
    // Only upload_file is sent this way.
    if (!whole || typeof whole !== 'object' || whole.t !== 'call' || whole.tool !== 'upload_file') return bad('not an upload_file call');
    return whole;
  }

  async #handleCall(gen, m) {
    if (!Number.isSafeInteger(m.id)) return;
    let result;
    if (typeof m.tool !== 'string' || !m.args || typeof m.args !== 'object' || Array.isArray(m.args)) {
      result = { ok: false, error: { code: 'bad_args', message: 'Malformed call.' } };
    } else {
      try {
        this.#running.add(m.id);
        result = await this.#o.onCall(m.tool, m.args, {
          live: () => gen === this.#gen && this.#phase === 'connected',
          cancelled: () => gen === this.#gen && this.#cancelled.has(m.id),
        });
      } catch (e) {
        result = { ok: false, error: { code: 'internal', message: `Unexpected extension error: ${e?.message ?? e}` } };
      } finally {
        if (gen === this.#gen) {
          this.#running.delete(m.id);
          this.#cancelled.delete(m.id);
        }
      }
    }
    if (gen !== this.#gen) return;
    this.#send(gen, { t: 'result', id: m.id, ...result });
  }

  #heartbeat(gen) {
    if (gen !== this.#gen || this.#phase !== 'connected') return;
    if (this.#pongTimer) return; // still waiting for the last pong
    this.#pongTimer = setTimeout(() => this.#down(gen, 'timeout'), this.#o.pongTimeoutMs);
    this.#send(gen, { t: 'ping' });
  }

  /** Encrypt and send, splitting big messages into fragments; keeps wire order. */
  #send(gen, obj) {
    let text = JSON.stringify(obj);
    const bytes = utf8Length(text);
    if (bytes > MAX_MESSAGE_BYTES && obj.t === 'result') {
      text = JSON.stringify({
        t: 'result', id: obj.id, ok: false,
        error: { code: 'too_large', message: `The result is too large to send (${Math.round(bytes / 1048576)} MB). Ask for less, e.g. a smaller screenshot or a narrower selector.` },
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
    this.#downCode = code;
    if (code === 'offline' || (code !== 'replaced' && code !== 'insecure_url' && !this.#o.isOnline())) {
      // No network: no point retrying on a timer; networkBack() or tick() reconnects.
      this.#downCode = 'offline';
      this.#waitingForNetwork = true;
      this.#setStatus({ conn: 'disconnected', error: { code: 'offline' }, retryAt: null });
      return;
    }
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

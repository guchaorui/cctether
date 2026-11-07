// The extension entrance (SPEC §4.4, D7–D9): a WebSocket server on 127.0.0.1 that only accepts
// the cctether extension, authenticates it with a mutual challenge–response, and then exchanges
// encrypted messages. At most one browser is connected; a newly authenticated one replaces the old.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { EventEmitter } from 'node:events';
import {
  PROTO, LABEL_SERVER, LABEL_CLIENT, CLOSE, HANDSHAKE_TIMEOUT_MS, IDLE_TIMEOUT_MS,
  MAX_FROM_EXTENSION, MAX_TO_EXTENSION, b64u, fromB64u, newNonce, proof, proofMatches,
  deriveSessionKeys, SessionCipher,
} from './protocol.js';
import { FailureLimiter, clientIp } from './ratelimit.js';

/** Max size of one WebSocket frame in either direction. Bigger messages arrive as fragments. */
export const MAX_FRAME = 1024 * 1024;
const MAX_HANDSHAKE_MESSAGE = 2048;
const MAX_PENDING_HANDSHAKES = 16;

export class GatewayError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Gateway extends EventEmitter {
  #key;
  #origins;
  #path;
  #version;
  #log;
  #limiter;
  #http;
  #wss;
  #pendingHandshakes = 0;
  /** @type {BrowserConnection|null} */
  #browser = null;
  #handshakeTimeoutMs;
  #idleTimeoutMs;

  constructor({
    key, extensionIds, path = '/cctether', version, log = () => {}, limiter = new FailureLimiter(),
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS, idleTimeoutMs = IDLE_TIMEOUT_MS, trustProxy = false,
  }) {
    super();
    this.trustProxy = trustProxy;
    this.#handshakeTimeoutMs = handshakeTimeoutMs;
    this.#idleTimeoutMs = idleTimeoutMs;
    this.#key = key;
    this.#origins = new Set(extensionIds.map((id) => `chrome-extension://${id}`));
    this.#path = path;
    this.#version = version;
    this.#log = log;
    this.#limiter = limiter;
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
    this.#http = createServer((req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found\n');
    });
    this.#http.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
    this.#http.on('clientError', (_err, socket) => socket.destroy());
  }

  listen(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      this.#http.once('error', onError);
      this.#http.listen(port, host, () => {
        this.#http.off('error', onError);
        resolve(this.#http.address().port);
      });
    });
  }

  setKey(key) {
    if (Buffer.compare(key, this.#key) === 0) return;
    this.#key = key;
    if (this.#browser) {
      this.#log('key changed: disconnecting the browser');
      this.#browser.close(CLOSE.keyChanged, 'key_changed');
    }
  }

  setExtensionIds(ids) {
    this.#origins = new Set(ids.map((id) => `chrome-extension://${id}`));
  }

  get browser() {
    return this.#browser;
  }

  status() {
    const b = this.#browser;
    return b ? { connected: true, since: b.since, ip: b.ip, info: b.info } : { connected: false };
  }

  /**
   * Run a tool in the browser.
   * @returns {Promise<{ ok: true, data: any } | { ok: false, error: { code: string, message: string } }>}
   */
  call(tool, args, timeoutMs) {
    if (!this.#browser) {
      return Promise.reject(new GatewayError('no_browser', 'No browser is connected.'));
    }
    return this.#browser.call(tool, args, timeoutMs);
  }

  async close() {
    if (this.#browser) this.#browser.close(CLOSE.shutdown, 'shutdown');
    for (const ws of this.#wss.clients) ws.terminate();
    const closed = new Promise((r) => this.#http.close(() => r()));
    this.#http.closeAllConnections();
    await closed;
  }

  // --- connection setup ------------------------------------------------------------------

  #onUpgrade(req, socket, head) {
    const ip = clientIp(req, { trustProxy: this.trustProxy });
    const reject = (status, text) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on('error', () => {});
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return reject(400, 'Bad Request');
    }
    if (pathname !== this.#path) return reject(404, 'Not Found');
    if (this.#pendingHandshakes >= MAX_PENDING_HANDSHAKES) return reject(503, 'Service Unavailable');

    // Refusals below are sent as a WebSocket message: a browser can't read an HTTP status code
    // from a failed WebSocket, and the extension wants to show the user what's wrong.
    let refusal = null;
    const origin = req.headers.origin;
    if (!origin || !this.#origins.has(origin)) {
      refusal = 'origin_rejected';
      this.#log(`refused ${ip}: origin ${JSON.stringify(origin ?? null).slice(0, 80)} is not an allowed extension`);
    } else if (this.#limiter.isBlocked(ip)) {
      refusal = 'rate_limited';
      this.#log(`refused ${ip}: too many failed attempts`);
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      if (refusal) {
        ws.send(JSON.stringify({ t: 'error', code: refusal }));
        ws.close(refusal === 'origin_rejected' ? CLOSE.originRejected : CLOSE.authFailed);
        return;
      }
      this.#handshake(ws, ip);
    });
  }

  #handshake(ws, ip) {
    this.#pendingHandshakes++;
    let done = false;
    const key = this.#key;
    let state = 'hello';
    let cn;
    let sn;

    const finish = () => {
      if (done) return;
      done = true;
      this.#pendingHandshakes--;
      clearTimeout(timer);
      ws.off('message', onMessage);
    };
    const fail = (why, { count = true, code = CLOSE.protocolError, error } = {}) => {
      if (done) return;
      finish();
      if (count) this.#limiter.fail(ip);
      this.#log(`handshake failed from ${ip}: ${why}`);
      if (error) ws.send(JSON.stringify(error));
      ws.close(code);
    };
    const timer = setTimeout(() => fail('timeout', { code: CLOSE.timeout }), this.#handshakeTimeoutMs);

    const onMessage = (data, isBinary) => {
      if (isBinary || data.length > MAX_HANDSHAKE_MESSAGE) return fail('unexpected frame');
      let m;
      try {
        m = JSON.parse(data.toString('utf8'));
      } catch {
        return fail('bad json');
      }
      if (!m || typeof m !== 'object') return fail('bad message');

      if (state === 'hello') {
        if (m.t !== 'hello') return fail('expected hello');
        if (m.proto !== PROTO) {
          const code = typeof m.proto === 'number' && m.proto > PROTO ? 'update_server' : 'update_extension';
          return fail(`protocol ${JSON.stringify(m.proto)} vs ${PROTO}`, {
            count: false, code: CLOSE.versionMismatch, error: { t: 'error', code, proto: PROTO },
          });
        }
        cn = fromB64u(m.cn, 32);
        if (!cn) return fail('bad nonce');
        sn = newNonce();
        ws.send(JSON.stringify({ t: 'challenge', proto: PROTO, sn: b64u(sn), sp: b64u(proof(key, LABEL_SERVER, cn, sn)) }));
        state = 'auth';
        return;
      }

      // state === 'auth'
      if (m.t !== 'auth') return fail('expected auth');
      const cp = fromB64u(m.cp, 32);
      if (!cp || !proofMatches(proof(key, LABEL_CLIENT, cn, sn), cp)) {
        return fail('wrong key', { code: CLOSE.authFailed, error: { t: 'error', code: 'auth_rejected' } });
      }
      if (key !== this.#key) {
        // The key was rotated during the handshake.
        return fail('key changed during handshake', { count: false, code: CLOSE.keyChanged });
      }
      finish();
      const { c2s, s2c } = deriveSessionKeys(key, cn, sn);
      this.#adopt(new BrowserConnection(ws, new SessionCipher(s2c, c2s), ip, this.#version, this.#log, this.#idleTimeoutMs));
    };

    ws.on('message', onMessage);
    // A client that hangs up after reading our challenge is usually the extension refusing a
    // server whose proof didn't match its key — not an attack, so it is not counted.
    ws.on('close', () => finish());
    ws.on('error', () => {});
  }

  #adopt(conn) {
    const old = this.#browser;
    this.#browser = conn;
    if (old) {
      this.#log(`browser from ${old.ip} replaced by a new connection from ${conn.ip}`);
      old.close(CLOSE.replaced, 'replaced');
    }
    this.#log(`browser connected from ${conn.ip}`);
    conn.on('info', () => this.emit('browser', this.status()));
    conn.once('closed', (why) => {
      if (this.#browser === conn) {
        this.#browser = null;
        this.#log(`browser disconnected (${why})`);
        this.emit('browser', this.status());
      }
    });
    conn.start();
  }
}

/** An authenticated browser connection. */
export class BrowserConnection extends EventEmitter {
  #ws;
  #cipher;
  #nextId = 1;
  #pending = new Map(); // id → { resolve, reject, timer }
  #idleTimer = null;
  #fragments = null; // string[] while a fragmented message is arriving
  #fragmentsSize = 0;
  #closed = false;

  #idleTimeoutMs;

  constructor(ws, cipher, ip, version, log, idleTimeoutMs = IDLE_TIMEOUT_MS) {
    super();
    this.#idleTimeoutMs = idleTimeoutMs;
    this.#ws = ws;
    this.#cipher = cipher;
    this.ip = ip;
    this.since = Date.now();
    this.info = null;
    this.version = version;
    this.log = log;
  }

  start() {
    this.#ws.on('message', (data, isBinary) => this.#onFrame(data, isBinary));
    this.#ws.on('close', (code) => this.#onClosed(`code ${code}`));
    this.#ws.on('error', () => {});
    this.#touch();
    this.#send({ t: 'welcome', server: this.version });
  }

  call(tool, args, timeoutMs) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (this.#closed) return reject(new GatewayError('disconnected', 'The browser disconnected.'));
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new GatewayError('timeout', `The browser did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ t: 'call', id, tool, args });
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new GatewayError('too_large', e.message));
      }
    });
  }

  /** Close, telling the extension why first. */
  close(code, reason) {
    if (this.#closed) return;
    try {
      if (reason) this.#send({ t: 'bye', reason });
    } catch {}
    this.#ws.close(code);
    this.#onClosed(reason ?? `code ${code}`);
  }

  #send(obj) {
    const frame = this.#cipher.seal(obj);
    if (frame.length > MAX_TO_EXTENSION) throw new Error('Message to the browser is too large.');
    this.#ws.send(frame);
  }

  #touch() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.log('browser connection idle for too long');
      this.close(CLOSE.timeout, null);
    }, this.#idleTimeoutMs);
  }

  #protocolError(why) {
    this.log(`protocol error from browser: ${why}`);
    this.close(CLOSE.protocolError, null);
  }

  #onFrame(data, isBinary) {
    if (this.#closed) return;
    if (!isBinary) return this.#protocolError('text frame after handshake');
    let msg;
    try {
      msg = this.#cipher.open(data);
    } catch {
      return this.#protocolError('could not decrypt');
    }
    this.#touch();

    if (msg.t === 'frag') {
      // A big message split into pieces: { t: 'frag', s: <slice of the JSON text>, end?: true }
      if (typeof msg.s !== 'string') return this.#protocolError('bad fragment');
      this.#fragments ??= [];
      this.#fragments.push(msg.s);
      this.#fragmentsSize += msg.s.length;
      if (this.#fragmentsSize > MAX_FROM_EXTENSION) return this.#protocolError('message too large');
      if (!msg.end) return;
      const text = this.#fragments.join('');
      this.#fragments = null;
      this.#fragmentsSize = 0;
      try {
        msg = JSON.parse(text);
      } catch {
        return this.#protocolError('bad fragmented message');
      }
      if (!msg || typeof msg !== 'object' || msg.t === 'frag') return this.#protocolError('bad fragmented message');
    } else if (this.#fragments) {
      return this.#protocolError('interleaved fragments');
    }

    switch (msg.t) {
      case 'ping':
        this.#send({ t: 'pong' });
        break;
      case 'info':
        this.info = sanitizeInfo(msg);
        this.log(`browser: ${this.info.browser ?? '?'}, extension ${this.info.extension ?? '?'}`);
        this.emit('info', this.info);
        break;
      case 'result': {
        const p = this.#pending.get(msg.id);
        if (!p) break; // timed out already
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok === true) p.resolve({ ok: true, data: msg.data });
        else {
          const e = msg.error ?? {};
          p.resolve({
            ok: false,
            error: {
              code: typeof e.code === 'string' ? e.code.slice(0, 40) : 'internal',
              message: typeof e.message === 'string' ? e.message.slice(0, 4000) : 'The browser reported an error.',
            },
          });
        }
        break;
      }
      default:
        // Unknown message types are ignored so newer extensions can add optional messages.
        break;
    }
  }

  #onClosed(why) {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#idleTimer);
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new GatewayError('disconnected', 'The browser disconnected before answering.'));
    }
    this.#pending.clear();
    this.emit('closed', why);
  }
}

function sanitizeInfo(m) {
  const str = (v, n = 120) => (typeof v === 'string' ? v.slice(0, n) : null);
  return { extension: str(m.extension, 20), browser: str(m.browser), platform: str(m.platform, 40) };
}

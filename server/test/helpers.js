import { WebSocket as WsClient } from 'ws';
import { randomBytes } from 'node:crypto';
import { Gateway } from '../src/gateway.js';
import { FailureLimiter } from '../src/ratelimit.js';
import { Connection } from '../../extension/background/connection.js';
import { DEFAULT_EXTENSION_IDS } from '../src/config.js';

export const EXT_ID = DEFAULT_EXTENSION_IDS[0];
export const ORIGIN = `chrome-extension://${EXT_ID}`;

export async function startGateway(opts = {}) {
  const key = opts.key ?? randomBytes(32);
  const logs = [];
  const gw = new Gateway({
    key, extensionIds: [EXT_ID], version: '9.9.9', log: (m) => logs.push(m),
    limiter: opts.limiter ?? new FailureLimiter(), handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 1000,
    idleTimeoutMs: opts.idleTimeoutMs,
  });
  const port = await gw.listen(0);
  return { gw, key, port, url: `ws://127.0.0.1:${port}/cctether`, logs };
}

/** The real extension connection code, with a Node WebSocket that can set Origin. */
export function makeExtension({ url, key, origin = ORIGIN, onCall, headers } = {}) {
  const statuses = [];
  let status = {};
  const waiters = [];
  const conn = new Connection({
    createSocket: (u) => new WsClient(u, { origin, headers }),
    onStatus: (patch) => {
      status = { ...status, ...patch };
      statuses.push(status);
      for (const w of [...waiters]) if (w.pred(status)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(status); }
    },
    onCall: onCall ?? (async (tool, args) => ({ ok: true, data: { content: [{ type: 'text', text: `${tool}:${JSON.stringify(args)}` }] } })),
    getInfo: () => ({ extension: '0.1.0', browser: 'TestBrowser 1', platform: 'test' }),
  });
  return {
    conn,
    statuses,
    get status() { return status; },
    waitFor(pred, ms = 3000) {
      if (pred(status)) return Promise.resolve(status);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout; last status ${JSON.stringify(status)}`)); } }, ms);
      });
    },
    start: () => conn.start({ url, key: new Uint8Array(key) }),
    stop: () => conn.stop(),
  };
}

/** A raw client for poking at the handshake by hand. */
export function rawClient(url, { origin = ORIGIN, headers } = {}) {
  const ws = new WsClient(url, { origin, headers });
  const inbox = [];
  const waiters = [];
  let closed = null;
  ws.on('message', (data, isBinary) => {
    const m = isBinary ? data : JSON.parse(data.toString());
    const w = waiters.shift();
    if (w) w(m); else inbox.push(m);
  });
  const closedP = new Promise((r) => ws.on('close', (code) => { closed = code; r(code); }));
  ws.on('error', () => {});
  return {
    ws,
    opened: new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }))); }),
    next: (ms = 2000) => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve, reject) => {
      waiters.push(resolve);
      setTimeout(() => reject(new Error('no message')), ms);
    }),
    closed: closedP,
    get closeCode() { return closed; },
    send: (obj) => ws.send(typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj)),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

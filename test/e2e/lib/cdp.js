// Minimal Chrome DevTools Protocol client for tests. Uses Node's built-in WebSocket.

export class CDP {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', (e) => reject(new Error(`CDP connect failed: ${e.message ?? e}`)), { once: true });
    });
    return new CDP({
      send: (data) => ws.send(data),
      onMessage: (fn) => ws.addEventListener('message', (ev) => fn(ev.data)),
      onClose: (fn) => ws.addEventListener('close', fn),
      close: () => ws.close(),
    });
  }

  /** Connect over --remote-debugging-pipe (fd 3 = to Chrome, fd 4 = from Chrome, NUL-delimited). */
  static fromPipe(writable, readable) {
    let buf = '';
    const msgFns = [];
    readable.setEncoding('utf8');
    readable.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const m = buf.slice(0, i);
        buf = buf.slice(i + 1);
        for (const f of msgFns) f(m);
      }
    });
    return new CDP({
      send: (data) => writable.write(data + '\0'),
      onMessage: (fn) => msgFns.push(fn),
      onClose: (fn) => readable.on('close', fn),
      close: () => { writable.end(); },
    });
  }

  constructor(transport) {
    this.#ws = transport;
    transport.onMessage((data) => {
      const msg = JSON.parse(data);
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(`${p.method}: ${msg.error.message}`), { cdp: msg.error }));
        else p.resolve(msg.result);
        return;
      }
      for (const l of this.#listeners) l(msg);
    });
    transport.onClose(() => {
      for (const p of this.#pending.values()) p.reject(new Error('CDP connection closed'));
      this.#pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(msg));
    });
  }

  /** Subscribe to all events. Returns an unsubscribe function. */
  onEvent(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  waitForEvent(method, predicate = () => true, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
      const off = this.onEvent((msg) => {
        if (msg.method === method && predicate(msg.params, msg)) {
          clearTimeout(timer); off(); resolve(msg.params);
        }
      });
    });
  }

  /** Attach to a target with flatten=true and return a session helper. */
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return {
      sessionId,
      send: (method, params) => this.send(method, params, sessionId),
      evaluate: async (expression) => {
        const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) {
          const d = r.exceptionDetails;
          throw new Error(`evaluate failed: ${d.exception?.description ?? d.text}`);
        }
        return r.result.value;
      },
      detach: () => this.send('Target.detachFromTarget', { sessionId }).catch(() => {}),
    };
  }

  close() { try { this.#ws.close(); } catch {} }
}

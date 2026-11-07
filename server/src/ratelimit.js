// Per-IP limit on failed handshakes (SPEC §4.4): 5 failures within 1 minute → blocked for 5 minutes.

export class FailureLimiter {
  #entries = new Map(); // ip → { fails: number[], blockedUntil: number }

  constructor({ maxFailures = 5, windowMs = 60_000, blockMs = 5 * 60_000, maxEntries = 10_000, now = Date.now } = {}) {
    Object.assign(this, { maxFailures, windowMs, blockMs, maxEntries, now });
  }

  isBlocked(ip) {
    const e = this.#entries.get(ip);
    return !!e && e.blockedUntil > this.now();
  }

  /** Record a failure. Returns true if the IP is now blocked. */
  fail(ip) {
    const t = this.now();
    let e = this.#entries.get(ip);
    if (!e) {
      if (this.#entries.size >= this.maxEntries) this.#prune(t);
      e = { fails: [], blockedUntil: 0 };
      this.#entries.set(ip, e);
    }
    e.fails = e.fails.filter((x) => t - x < this.windowMs);
    e.fails.push(t);
    if (e.fails.length >= this.maxFailures) {
      e.blockedUntil = t + this.blockMs;
      e.fails = [];
    }
    return e.blockedUntil > t;
  }

  #prune(t) {
    for (const [ip, e] of this.#entries) {
      if (e.blockedUntil <= t && e.fails.every((x) => t - x >= this.windowMs)) this.#entries.delete(ip);
    }
    // Still full (an attack from many addresses): drop the oldest entries.
    while (this.#entries.size >= this.maxEntries) this.#entries.delete(this.#entries.keys().next().value);
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The address to rate-limit by. Behind a local reverse proxy (Caddy, cloudflared) every peer is
 * loopback; with `trustProxy` the last X-Forwarded-For entry (the address the proxy saw) is used
 * instead. Without it the header is ignored: any local process could otherwise forge it to dodge
 * the limiter or get an innocent address blocked.
 */
export function clientIp(req, { trustProxy = false } = {}) {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (!trustProxy || !LOOPBACK.has(peer)) return peer;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const last = xff.split(',').pop().trim();
    if (last && last.length <= 64) return last;
  }
  return peer;
}

// `cctether check` (SPEC §8.2): connect to an address the way the extension does and see whether
// it leads to *this* cctether service. Only the server's half of the handshake is used: we verify
// its proof with our key and hang up without sending ours, so a connected browser isn't replaced
// and the attempt doesn't count as a failed login.

import { WebSocket } from 'ws';
import { PROTO, LABEL_SERVER, b64u, fromB64u, newNonce, proof, proofMatches, CLOSE } from './protocol.js';

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/;

/**
 * @param {object} o
 * @param {string} o.url        ws:// or wss:// address, as in the connection code
 * @param {Buffer} o.key        this service's key
 * @param {string} o.extensionId an allowed extension ID (sent as the Origin)
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, status?: number, detail?: string }>}
 *   reason: dns | refused | timeout | tls | http | wrong_server | not_cctether | origin_rejected |
 *           rate_limited | update_server | update_extension | closed | error
 */
export function checkAddress({ url, key, extensionId, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const cn = newNonce();
    let ws;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.terminate(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), timeoutMs);
    try {
      ws = new WebSocket(url, {
        origin: `chrome-extension://${extensionId}`,
        handshakeTimeout: timeoutMs,
        maxPayload: 64 * 1024,
        perMessageDeflate: false,
        followRedirects: false,
      });
    } catch (e) {
      return done({ ok: false, reason: 'error', detail: e.message });
    }
    ws.on('unexpected-response', (_req, res) => {
      done({ ok: false, reason: 'http', status: res.statusCode });
      res.destroy();
    });
    ws.on('error', (e) => done(classifyError(e)));
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', proto: PROTO, cn: b64u(cn) }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return done({ ok: false, reason: 'not_cctether' });
      let m;
      try { m = JSON.parse(data.toString('utf8')); } catch { return done({ ok: false, reason: 'not_cctether' }); }
      if (m?.t === 'error') {
        const known = ['origin_rejected', 'rate_limited', 'update_server', 'update_extension'];
        return done({ ok: false, reason: known.includes(m.code) ? m.code : 'not_cctether' });
      }
      if (m?.t !== 'challenge') return done({ ok: false, reason: 'not_cctether' });
      if (m.proto !== PROTO) {
        return done({ ok: false, reason: typeof m.proto === 'number' && m.proto > PROTO ? 'update_extension' : 'update_server' });
      }
      const sn = fromB64u(m.sn, 32);
      const sp = fromB64u(m.sp, 32);
      if (!sn || !sp) return done({ ok: false, reason: 'not_cctether' });
      done(proofMatches(proof(key, LABEL_SERVER, cn, sn), sp) ? { ok: true } : { ok: false, reason: 'wrong_server' });
    });
    ws.on('close', (code) => {
      if (code === CLOSE.originRejected) return done({ ok: false, reason: 'origin_rejected' });
      done({ ok: false, reason: 'closed', detail: code ? `code ${code}` : '' });
    });
  });
}

function classifyError(e) {
  const code = e?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return { ok: false, reason: 'dns' };
  if (code === 'ECONNREFUSED') return { ok: false, reason: 'refused' };
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || /timed out/i.test(e?.message ?? '')) {
    return { ok: false, reason: 'timeout' };
  }
  if (TLS_CODES.test(code)) return { ok: false, reason: 'tls', detail: code };
  if (code === 'ECONNRESET' || code === 'EPIPE') return { ok: false, reason: 'closed', detail: code };
  return { ok: false, reason: 'error', detail: (e?.message ?? String(e)).slice(0, 200) };
}

/** Turn a failed checkAddress() result into a sentence, with the text function from text.js. */
export function explainCheck(t, r, { url, port, extensionId, local }) {
  const u = new URL(url);
  const host = u.hostname;
  const upstreamPort = u.port || (u.protocol === 'wss:' ? 443 : 80);
  switch (r.reason) {
    case 'dns': return t('check.why.dns', { host });
    case 'refused': return t(local ? 'check.why.refusedLocal' : 'check.why.refused', { host, port: upstreamPort });
    case 'timeout': return t('check.why.timeout', { port: upstreamPort });
    case 'tls': return t('check.why.tls', { detail: r.detail ?? 'TLS' });
    case 'http':
      return t(r.status === 502 || r.status === 503 || r.status === 504 ? 'check.why.http502' : 'check.why.http', {
        status: r.status, path: u.pathname, port,
      });
    case 'origin_rejected': return t('check.why.origin_rejected', { id: extensionId });
    case 'closed': return t('check.why.closed', { detail: r.detail ? ` (${r.detail})` : '' });
    case 'error': return t('check.why.error', { detail: r.detail ?? '' });
    default: return t(`check.why.${r.reason}`);
  }
}

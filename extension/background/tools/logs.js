// console_messages, network_requests, handle_dialog: read the per-tab buffers kept by
// debugger.js, and close JS dialogs.

import { ToolError } from './errors.js';
import { untrusted, q, clip, fmtBytes, fmtTime, utcOffset } from './util.js';
import { CdpError } from '../debugger.js';
import { tabSummary } from './browser.js';
import { settle } from './input.js';

const text = (t) => ({ type: 'text', text: t });

function sinceNote(s) {
  return `cctether records a tab's messages and requests only while it is attached to the tab (this time since ${fmtTime(s.attachedAt)})`;
}

// ---- console_messages --------------------------------------------------------------------------

export async function consoleMessages({ tab, s }, args) {
  const level = args.level ?? 'all';
  const limit = args.limit ?? 50;
  const pat = args.pattern?.toLowerCase();
  await s.settled();
  let list = s.console;
  if (level === 'error') list = list.filter((e) => e.level === 'error');
  else if (level === 'warning') list = list.filter((e) => e.level === 'error' || e.level === 'warning');
  if (pat) list = list.filter((e) => `${e.source}: ${e.text} ${e.where}`.toLowerCase().includes(pat));
  const shown = list.slice(-limit);
  if (args.clear) s.console = [];
  const filters = [level !== 'all' && `level ${level}`, pat && `containing ${q(args.pattern, 100)}`].filter(Boolean).join(', ');
  if (!shown.length) {
    const why = s.console.length || list !== s.console
      ? `No console messages${filters ? ` match (${filters})` : ''} in tab ${tab.id}.`
      : `No console messages in tab ${tab.id}.`;
    return {
      content: [text(`${why} ${sinceNote(s)}; earlier messages of the current page are included when Chrome still has them. To capture everything from the start, reload the page (navigate with action: "reload").${args.clear ? ' The buffer was cleared.' : ''}`)],
    };
  }
  const lines = shown.map((e) => `${fmtTime(e.t)} ${e.level} ${e.source}: ${e.text.replace(/\n/g, '\n    ')}${e.where ? ` (${e.where})` : ''}`);
  const head = `${shown.length} of ${list.length} console message${list.length === 1 ? '' : 's'}${filters ? ` (${filters})` : ''} in tab ${tab.id}, oldest first. Times are browser-local (${utcOffset()}).`;
  return { content: [text(`${head}\n${untrusted(lines.join('\n'))}${args.clear ? '\nThe buffer was cleared.' : ''}`)] };
}

// ---- network_requests --------------------------------------------------------------------------

const BODY_MAX = 20000;
const HIDDEN_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization)$/i;

function statusOf(e) {
  if (e.failed) return `FAILED ${e.errorText || ''}`.trim();
  if (e.status != null) return String(e.status);
  return 'pending';
}

function durationOf(e) {
  return e.endTs != null && e.startTs != null ? `${Math.round((e.endTs - e.startTs) * 1000)} ms` : '';
}

function listLine(e) {
  const bits = [`#${e.id}`, e.method, statusOf(e), e.type, clip(e.url, 300)];
  const extra = [];
  if (e.size != null) extra.push(fmtBytes(e.size));
  const d = durationOf(e);
  if (d) extra.push(d);
  if (e.fromCache) extra.push('cache');
  if (e.redirectedTo) extra.push('redirect');
  return `${bits.join(' ')}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

function headerLines(h) {
  const entries = Object.entries(h ?? {});
  if (!entries.length) return ['  (none recorded)'];
  return entries.map(([k, v]) => {
    const val = HIDDEN_HEADERS.test(k) ? `[hidden by cctether, ${String(v).length} characters]` : clip(String(v).replace(/\n/g, ', '), 2000);
    return `  ${k}: ${val}`;
  });
}

const TEXT_MIME = /^text\/|json|javascript|ecmascript|xml|x-www-form-urlencoded|graphql|csv|svg|yaml|toml|x-ndjson/i;

function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function bodyText(label, body) {
  if (body.length <= BODY_MAX) return [`${label} (${body.length} characters):`, body];
  return [`${label} (showing the first ${BODY_MAX} of ${body.length} characters):`, `${body.slice(0, BODY_MAX)}…`];
}

async function responseBody(s, e) {
  if (e.type === 'websocket') return ['Response body: not available for WebSockets (frames are not recorded).'];
  if (!e.finished) return ['Response body: the request is still in progress.'];
  if (e.failed) return ['Response body: none (the request failed).'];
  if (e.redirectedTo) return [`Response body: none (redirect to ${clip(e.redirectedTo, 300)}).`];
  if (e.method === 'HEAD' || e.status === 204 || e.status === 304) return ['Response body: none.'];
  let r;
  try {
    r = await s.send('Network.getResponseBody', { requestId: e.requestId }, { timeoutMs: 8000 });
  } catch (err) {
    const why = err instanceof CdpError ? err.cdpMessage : err.message;
    return [`Response body: not available (${clip(why, 200)}). Chrome keeps bodies only for recent requests of the current page; reload and ask again if needed.`];
  }
  let isText = TEXT_MIME.test(e.mimeType || '');
  if (r.base64Encoded && !isText && !/^(image|audio|video|font)\//i.test(e.mimeType || '')) {
    // Unknown type: show it if it decodes as clean UTF-8 text.
    const probe = decodeBase64Utf8(r.body.slice(0, 8000));
    isText = !/[\u0000-\u0008\u000e-\u001f\ufffd]/.test(probe.slice(0, 2000));
  }
  if (r.base64Encoded && !isText) {
    const bytes = Math.floor((r.body.length * 3) / 4);
    return [`Response body: binary (${e.mimeType || 'unknown type'}, about ${fmtBytes(bytes)}), not shown.`];
  }
  const body = r.base64Encoded ? decodeBase64Utf8(r.body) : r.body;
  return bodyText('Response body', body);
}

async function requestBody(s, e) {
  if (e.postData != null) return bodyText('Request body', e.postData);
  if (!e.hasPostData) return [];
  try {
    const r = await s.send('Network.getRequestPostData', { requestId: e.requestId }, { timeoutMs: 5000 });
    return bodyText('Request body', r.postData ?? '');
  } catch {
    return ['Request body: present but not available.'];
  }
}

async function networkDetail(tab, s, id) {
  const e = s.network.find((x) => x.id === id);
  if (!e) {
    throw new ToolError('not_found', `There is no request #${id} in tab ${tab.id}'s list. The list keeps the newest 500 requests and starts over when cctether re-attaches to the tab. Call network_requests to see the current numbers.`);
  }
  const info = [`Type: ${e.type}`, `Status: ${statusOf(e)}${e.statusText ? ` ${e.statusText}` : ''}`];
  if (e.mimeType) info.push(`MIME: ${e.mimeType}`);
  if (e.size != null) info.push(`Transferred: ${fmtBytes(e.size)}`);
  const d = durationOf(e);
  if (d) info.push(`Time: ${d}`);
  info.push(`Started: ${fmtTime(e.wallTime)}`);
  const net = [];
  if (e.remote) net.push(`Remote: ${e.remote}`);
  if (e.protocol) net.push(`Protocol: ${e.protocol}`);
  net.push(`From cache: ${e.fromCache ? 'yes' : 'no'}${e.fromServiceWorker ? ' (service worker)' : ''}`);
  const lines = [`#${e.id} ${e.method} ${e.url}`, info.join(' · '), net.join(' · ')];
  if (e.redirectedTo) lines.push(`Redirected to: ${e.redirectedTo}`);
  lines.push('', 'Request headers:', ...headerLines(e.requestHeaders));
  const rb = await requestBody(s, e);
  if (rb.length) lines.push(...rb);
  lines.push('', 'Response headers:', ...(e.responseHeaders ? headerLines(e.responseHeaders) : ['  (no response yet)']));
  lines.push(...(await responseBody(s, e)));
  return {
    content: [text(`${untrusted(lines.join('\n'))}\nCookie, Set-Cookie and Authorization header values are hidden.`)],
  };
}

export async function networkRequests({ tab, s }, args) {
  if (args.id != null) return networkDetail(tab, s, args.id);
  const limit = args.limit ?? 50;
  const pat = args.pattern?.toLowerCase();
  let list = s.network;
  if (pat) list = list.filter((e) => e.url.toLowerCase().includes(pat));
  if (args.type) list = list.filter((e) => e.type === args.type);
  if (args.failed) list = list.filter((e) => e.failed || (e.status ?? 0) >= 400);
  const shown = list.slice(-limit);
  if (args.clear) {
    s.network = [];
    s.byRequestId = new Map();
  }
  const filters = [pat && `URL containing ${q(args.pattern, 100)}`, args.type && `type ${args.type}`, args.failed && 'failed only'].filter(Boolean).join(', ');
  if (!shown.length) {
    const why = s.network.length || list !== s.network ? `No requests${filters ? ` match (${filters})` : ''}` : 'No requests recorded';
    return {
      content: [text(`${why} in tab ${tab.id}. ${sinceNote(s)}; earlier requests are not available. To capture the page's requests from the start, reload it (navigate with action: "reload") and call network_requests again.${args.clear ? ' The list was cleared.' : ''}`)],
    };
  }
  const head = `${shown.length} of ${list.length} request${list.length === 1 ? '' : 's'}${filters ? ` (${filters})` : ''} in tab ${tab.id}, oldest first:`;
  return {
    content: [text(`${head}\n${untrusted(shown.map(listLine).join('\n'))}\nCall network_requests with id for headers and body.${args.clear ? ' The list was cleared.' : ''}`)],
  };
}

// ---- handle_dialog -----------------------------------------------------------------------------

export async function handleDialog({ tab, s }, args) {
  const d = s.dialog;
  const before = (await tabSummary(tab.id)).url;
  const params = { accept: args.accept };
  if (args.accept && args.text != null) params.promptText = args.text;
  const w = s.navWatch();
  try {
    try {
      await s.send('Page.handleJavaScriptDialog', params, { timeoutMs: 5000 });
    } catch (e) {
      if (e instanceof CdpError && /no dialog/i.test(e.cdpMessage)) {
        s.dialog = null;
        throw new ToolError('not_found', `No JavaScript dialog is open in tab ${tab.id}.`);
      }
      throw e;
    }
    s.dialog = null;
    const what = d ? `the ${d.type} dialog${d.message ? ` ${q(d.message, 200)}` : ''}` : 'the dialog';
    const lines = [`${args.accept ? 'Accepted' : 'Dismissed'} ${what}${params.promptText != null && d?.type === 'prompt' ? ` with the answer ${q(params.promptText, 200)}` : ''}.`];
    if (args.text != null && d && d.type !== 'prompt') lines.push('(`text` was ignored: it is only used for prompt dialogs.)');
    const note = await settle(s, w, tab.id, before, { startMs: 300 });
    if (note) lines.push(note);
    return { content: [text(lines.join(' '))] };
  } finally {
    w.stop();
  }
}

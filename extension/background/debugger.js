// chrome.debugger (CDP 1.3) sessions, one per tab, attached on demand.
//
// Each session keeps per-tab buffers (console, network, the open JS dialog), tracks execution
// contexts so the 'cctether' isolated world can be re-created after navigation, and detaches
// after IDLE_MS without tool calls. main.js/app.js gets told about the attached-tab count and
// about the user pressing "Cancel" on Chrome's "is debugging this browser" bar.

import { ToolError } from './tools/errors.js';
import { withTimeout, sleep, q } from './tools/util.js';
import { formatConsoleArgs, consoleLevel, exceptionToText, location } from './tools/format.js';
import { isShared, restrictedMessage } from './tabs.js';
import { LIB_CALL } from './page-scripts.js';

const PROTOCOL = '1.3';
export const WORLD_NAME = 'cctether';
const IDLE_MS = 5 * 60 * 1000;
const CONSOLE_MAX = 500;
const NETWORK_MAX = 500;
const DEFAULT_TIMEOUT_MS = 10000;
const ENABLE_TIMEOUT_MS = 5000;
const POST_DATA_KEEP = 10000;

/** @type {Map<number, TabSession>} */
const sessions = new Map();
/** @type {Map<number, Promise<TabSession>>} */
const attaching = new Map();
let hooks = {};
let lastCancelNotice = 0;

/**
 * @param {{ onUserCanceled?: () => void, onAttachedCountChanged?: (n: number) => void }} h
 */
export function setDebuggerHooks(h) {
  hooks = { ...hooks, ...h };
}

export function attachedCount() {
  return sessions.size;
}

function notifyCount() {
  try { hooks.onAttachedCountChanged?.(sessions.size); } catch (e) { console.error(e); }
}

/** A CDP error answer (as opposed to a timeout or a detach). */
export class CdpError extends Error {
  constructor(method, message) {
    super(`${method}: ${message}`);
    this.method = method;
    this.cdpMessage = message;
  }
}

function chromeErrorText(e) {
  const raw = String(e?.message ?? e);
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.message === 'string') return j.message;
  } catch { /* not JSON */ }
  return raw;
}

function detachedError(tabId) {
  return new ToolError('no_tab', `cctether lost its connection to tab ${tabId} (the tab was closed, crashed or navigated to a page extensions can't control). Call list_tabs and try again.`);
}

/** "a JavaScript confirm dialog saying "…"" */
export function describeDialog(d) {
  const what = d.type === 'beforeunload' ? 'a "Leave site?" (beforeunload) dialog' : `a JavaScript ${d.type} dialog`;
  return `${what}${d.message ? ` saying ${q(d.message, 300)}` : ''}`;
}

export function dialogHint(d) {
  const how = d.type === 'prompt' ? 'accept: true with text for the answer, or accept: false' : 'accept: true or false';
  return `The page is frozen until it is closed: call handle_dialog first (${how}).`;
}

/** The error every tab tool (except handle_dialog) throws while a JS dialog is open. */
export function dialogError(tabId, d) {
  const desc = describeDialog(d);
  return new ToolError('dialog_open', `${desc[0].toUpperCase()}${desc.slice(1)} is open in tab ${tabId}. ${dialogHint(d)}`);
}

const NET_TYPES = {
  Document: 'document', XHR: 'xhr', Fetch: 'fetch', Script: 'script', Stylesheet: 'stylesheet',
  Image: 'image', Font: 'font', Media: 'media', WebSocket: 'websocket',
};
const netType = (t) => NET_TYPES[t] ?? 'other';

function needsPreview(a) {
  return a && a.type === 'object' && a.objectId && !a.preview && !['null', 'error', 'node', 'regexp', 'date'].includes(a.subtype);
}

/** Build a Runtime.ObjectPreview from Runtime.getProperties output (for replayed messages). */
function propsToPreview(o, props) {
  const isArray = o.subtype === 'array' || o.subtype === 'typedarray';
  const max = isArray ? 100 : 5;
  const own = props.filter((p) => p.enumerable && p.isOwn !== false && (!isArray || /^\d+$/.test(p.name)));
  const properties = own.slice(0, max).map((p) => {
    const v = p.value;
    if (!v) return { name: p.name, type: 'accessor', value: '(...)' };
    if (v.type === 'object' && v.subtype !== 'null') {
      return { name: p.name, type: 'object', subtype: v.subtype, value: v.description ?? 'Object' };
    }
    return {
      name: p.name, type: v.type, subtype: v.subtype,
      value: v.type === 'string' ? v.value : (v.unserializableValue ?? (v.type === 'undefined' ? 'undefined' : String(v.value ?? v.description))),
    };
  });
  return { type: 'object', subtype: o.subtype, description: o.description, overflow: own.length > max, properties };
}

function consoleText(type, args) {
  const text = formatConsoleArgs(args);
  if (type === 'assert') return `Assertion failed${text ? `: ${text}` : ''}`;
  if (type === 'clear') return 'console.clear() was called';
  if (type === 'trace') return `${text ? `${text} ` : ''}(console.trace)`;
  return text;
}

export function isContextGone(e) {
  return e instanceof CdpError && /Cannot find context|context was destroyed|Execution context|Inspected target navigated|No frame/i.test(e.cdpMessage);
}

class TabSession {
  constructor(tabId) {
    this.tabId = tabId;
    this.target = { tabId };
    this.closed = false;
    this.mainFrameId = null;
    this.busy = 0;
    this.idleTimer = null;
    this.attachedAt = Date.now();
    /** @type {Array<{t:number, level:string, source:string, text:string, where:string}>} */
    this.console = [];
    this.network = [];
    this.byRequestId = new Map();
    this.nextNetId = 1;
    this.dialog = null;
    this.contexts = new Map();
    this.worldCtx = null;
    this.worldPromise = null;
    this.listeners = new Set();
    this.pending = new Set();
    this.newDialogSignal();
  }

  newDialogSignal() {
    this.dialogSignal = new Promise((r) => { this.resolveDialog = r; });
  }

  touch() {
    clearTimeout(this.idleTimer);
    if (this.closed) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy > 0) this.touch();
      else detach(this.tabId);
    }, IDLE_MS);
  }

  /** Send a CDP command. Every call has a timeout: calls into a frozen page never answer. */
  async send(method, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (this.closed) throw detachedError(this.tabId);
    const p = chrome.debugger.sendCommand(this.target, method, params).catch((e) => {
      const msg = chromeErrorText(e);
      if (this.closed || /not attached|Detached while handling/i.test(msg)) throw detachedError(this.tabId);
      throw new CdpError(method, msg);
    });
    return withTimeout(p, timeoutMs, () => new ToolError('timeout',
      `The page did not answer within ${Math.round(timeoutMs / 100) / 10} s (${method}). It may be busy or frozen; try again, or reload it with navigate (action: "reload").`));
  }

  /** Reject with dialog_open as soon as a JS dialog opens while `promise` is pending. */
  guardDialog(promise) {
    if (this.dialog) {
      promise.catch(() => {});
      return Promise.reject(dialogError(this.tabId, this.dialog));
    }
    promise.catch(() => {});
    return Promise.race([promise, this.dialogSignal.then((d) => { throw dialogError(this.tabId, d); })]);
  }

  /** Resolve to { value } or, if a dialog opens first, { dialog }. */
  raceDialog(promise) {
    promise.catch(() => {});
    return Promise.race([promise.then((value) => ({ value })), this.dialogSignal.then((dialog) => ({ dialog }))]);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolve with { method, params } of the first event matching pred, or null after ms. */
  waitFor(pred, ms) {
    return new Promise((resolve) => {
      let off = null;
      const timer = setTimeout(() => { off?.(); resolve(null); }, ms);
      off = this.on((m, p) => {
        if (m === 'cctether.detached' || pred(m, p)) {
          clearTimeout(timer);
          off();
          resolve(m === 'cctether.detached' ? null : { method: m, params: p });
        }
      });
    });
  }

  /** Track main-frame navigation from now on. */
  navWatch() {
    const st = { requested: false, committed: false, loaded: false, sameDoc: false, stopped: false, status: null, bfcache: false, windowOpens: [] };
    let notify = null;
    const off = this.on((m, p) => {
      switch (m) {
        case 'Page.frameRequestedNavigation':
          if (p.frameId === this.mainFrameId && (p.disposition ?? 'currentTab') === 'currentTab') st.requested = true;
          break;
        case 'Page.frameStartedLoading':
          if (p.frameId === this.mainFrameId) st.requested = true;
          break;
        case 'Page.frameNavigated':
          if (!p.frame.parentId) {
            st.requested = st.committed = true;
            if (p.type === 'BackForwardCacheRestore') st.loaded = st.bfcache = true;
          }
          break;
        case 'Page.navigatedWithinDocument':
          if (p.frameId === this.mainFrameId) st.sameDoc = true;
          break;
        case 'Page.loadEventFired':
          if (st.committed) st.loaded = true;
          break;
        case 'Page.frameStoppedLoading':
          if (p.frameId === this.mainFrameId) {
            if (st.committed) st.loaded = true;
            else if (st.requested) st.stopped = true;
          }
          break;
        case 'Network.responseReceived':
          if (p.type === 'Document' && p.frameId === this.mainFrameId) st.status = p.response?.status ?? null;
          break;
        case 'Page.windowOpen':
          st.windowOpens.push(p.url);
          break;
        default:
          return;
      }
      notify?.();
    });
    const until = (pred, ms) => new Promise((resolve) => {
      if (pred(st)) { resolve(true); return; }
      const timer = setTimeout(() => { notify = null; resolve(false); }, Math.max(0, ms));
      notify = () => {
        if (pred(st) || this.closed) { clearTimeout(timer); notify = null; resolve(pred(st)); }
      };
    });
    return { st, until, stop: off };
  }

  async refreshFrame() {
    const r = await this.send('Page.getFrameTree', {}, { timeoutMs: ENABLE_TIMEOUT_MS });
    this.mainFrameId = r.frameTree.frame.id;
  }

  /** Execution context id of the 'cctether' isolated world in the main frame (created on demand). */
  async world() {
    if (this.worldCtx != null) return this.worldCtx;
    if (!this.worldPromise) {
      this.worldPromise = (async () => {
        if (!this.mainFrameId) await this.refreshFrame();
        const create = () => this.send('Page.createIsolatedWorld', { frameId: this.mainFrameId, worldName: WORLD_NAME, grantUniveralAccess: false });
        let r;
        try {
          r = await create();
        } catch (e) {
          if (!(e instanceof CdpError)) throw e;
          await this.refreshFrame();
          r = await create();
        }
        this.worldCtx = r.executionContextId;
        return this.worldCtx;
      })().finally(() => { this.worldPromise = null; });
    }
    return this.worldPromise;
  }

  /**
   * Call a function of the page library (page-scripts.js) in the isolated world. Library
   * functions report expected failures as { __error: { code, message } }.
   */
  async lib(fn, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    for (let attempt = 0; ; attempt++) {
      let ctx;
      try {
        ctx = await this.guardDialog(this.world());
        const r = await this.guardDialog(this.send('Runtime.callFunctionOn', {
          functionDeclaration: LIB_CALL,
          executionContextId: ctx,
          arguments: [{ value: fn }, { value: args }],
          returnByValue: true,
          awaitPromise: true,
        }, { timeoutMs }));
        if (r.exceptionDetails) {
          throw new ToolError('internal', `cctether's page script "${fn}" failed: ${exceptionToText(r.exceptionDetails)}`);
        }
        const v = r.result?.value;
        if (v && typeof v === 'object' && v.__error) throw new ToolError(v.__error.code, v.__error.message);
        return v;
      } catch (e) {
        if (attempt < 3 && isContextGone(e)) {
          if (ctx === undefined || this.worldCtx === ctx) this.worldCtx = null;
          await sleep(100 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
  }

  /** Forget the isolated world (e.g. after a navigation was detected). */
  resetWorld() {
    this.worldCtx = null;
  }

  // ---- events ------------------------------------------------------------------------------

  handleEvent(method, p) {
    switch (method) {
      case 'Runtime.executionContextCreated': {
        const c = p.context;
        this.contexts.set(c.id, { name: c.name, origin: c.origin, isDefault: !!c.auxData?.isDefault, type: c.auxData?.type, frameId: c.auxData?.frameId });
        break;
      }
      case 'Runtime.executionContextDestroyed':
        this.contexts.delete(p.executionContextId);
        if (p.executionContextId === this.worldCtx) this.worldCtx = null;
        break;
      case 'Runtime.executionContextsCleared':
        this.contexts.clear();
        this.worldCtx = null;
        break;
      case 'Runtime.consoleAPICalled': {
        const entry = { t: p.timestamp, level: consoleLevel(p.type), source: this.sourceLabel(p.executionContextId), text: consoleText(p.type, p.args), where: location('', null, p.stackTrace) };
        this.addConsole(entry);
        // Messages replayed by Runtime.enable carry objects without previews: describe them.
        if (p.args?.some(needsPreview)) this.track(this.enrichConsole(entry, p.type, p.args));
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails;
        this.addConsole({ t: p.timestamp, level: 'error', source: this.sourceLabel(d.executionContextId), text: exceptionToText(d), where: location(d.url, d.lineNumber, d.stackTrace) });
        break;
      }
      case 'Log.entryAdded': {
        const e = p.entry;
        this.addConsole({ t: e.timestamp, level: consoleLevel(e.level), source: 'browser', text: e.text ?? '', where: location(e.url, e.lineNumber, e.stackTrace) });
        break;
      }
      case 'Page.javascriptDialogOpening': {
        this.dialog = { type: p.type, message: p.message ?? '', url: p.url, defaultPrompt: p.defaultPrompt ?? '', since: Date.now() };
        const resolve = this.resolveDialog;
        this.newDialogSignal();
        resolve(this.dialog);
        break;
      }
      case 'Page.javascriptDialogClosed':
        this.dialog = null;
        break;
      case 'Page.frameNavigated':
        if (!p.frame.parentId) {
          this.mainFrameId = p.frame.id;
          this.addConsole({ t: Date.now(), level: 'info', source: 'cctether', text: `--- navigated to ${p.frame.url} ---`, where: '' });
        }
        break;
      case 'Network.requestWillBeSent': this.netRequest(p); break;
      case 'Network.responseReceived': this.netResponse(p); break;
      case 'Network.loadingFinished': this.netFinished(p); break;
      case 'Network.loadingFailed': this.netFailed(p); break;
      case 'Network.requestServedFromCache': {
        const e = this.byRequestId.get(p.requestId);
        if (e) e.fromCache = true;
        break;
      }
      case 'Network.webSocketCreated':
        this.netAdd({ requestId: p.requestId, url: p.url, method: 'GET', type: 'websocket', requestHeaders: {}, wallTime: Date.now(), startTs: null });
        break;
      case 'Network.webSocketHandshakeResponseReceived': {
        const e = this.byRequestId.get(p.requestId);
        if (e) { e.status = p.response.status; e.statusText = p.response.statusText; e.responseHeaders = p.response.headers; }
        break;
      }
      case 'Network.webSocketClosed': {
        const e = this.byRequestId.get(p.requestId);
        if (e) e.finished = true;
        break;
      }
      default:
        break;
    }
    for (const fn of [...this.listeners]) {
      try { fn(method, p); } catch (e) { console.error('cctether: event listener failed', e); }
    }
  }

  /** Remember a background job that console_messages should wait for. */
  track(promise) {
    const job = promise.catch(() => {}).finally(() => this.pending.delete(job));
    this.pending.add(job);
  }

  /** Wait (briefly) for background jobs such as console previews. */
  async settled(ms = 2000) {
    if (!this.pending.size) return;
    await Promise.race([Promise.allSettled([...this.pending]), sleep(ms)]);
  }

  async enrichConsole(entry, type, args) {
    const out = [];
    for (const a of args) {
      if (!needsPreview(a)) { out.push(a); continue; }
      try {
        // getProperties does not run page code (getters are reported, not called).
        const r = await this.send('Runtime.getProperties', { objectId: a.objectId, ownProperties: true, generatePreview: true }, { timeoutMs: 2000 });
        out.push({ ...a, preview: propsToPreview(a, r.result ?? []) });
      } catch {
        out.push(a);
      }
    }
    entry.text = consoleText(type, out);
  }

  sourceLabel(ctxId) {
    const c = this.contexts.get(ctxId);
    if (!c || c.isDefault) return c && c.frameId && this.mainFrameId && c.frameId !== this.mainFrameId ? 'page (iframe)' : 'page';
    if (c.origin?.startsWith('chrome-extension://')) return `extension ${c.name || c.origin.slice(19)}`;
    if (c.name === WORLD_NAME) return 'cctether';
    return c.name ? `script world ${c.name}` : 'page';
  }

  addConsole(entry) {
    if (entry.text.length > 4000) entry.text = `${entry.text.slice(0, 4000)}… (${entry.text.length} chars)`;
    this.console.push(entry);
    if (this.console.length > CONSOLE_MAX) this.console.splice(0, this.console.length - CONSOLE_MAX);
  }

  netAdd(e) {
    const entry = {
      id: this.nextNetId++, status: null, statusText: '', mimeType: '', responseHeaders: null,
      finished: false, failed: false, errorText: '', fromCache: false, size: null, endTs: null,
      postData: null, hasPostData: false, remote: '', protocol: '', ...e,
    };
    this.network.push(entry);
    this.byRequestId.set(entry.requestId, entry);
    if (this.network.length > NETWORK_MAX) {
      const old = this.network.shift();
      if (this.byRequestId.get(old.requestId) === old) this.byRequestId.delete(old.requestId);
    }
    return entry;
  }

  netRequest(p) {
    const prev = this.byRequestId.get(p.requestId);
    if (prev && p.redirectResponse) {
      applyResponse(prev, p.redirectResponse);
      prev.finished = true;
      prev.endTs = p.timestamp;
      prev.redirectedTo = p.request.url;
    }
    const pd = p.request.postData;
    this.netAdd({
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      type: netType(p.type),
      requestHeaders: p.request.headers ?? {},
      postData: pd ? (pd.length > POST_DATA_KEEP ? `${pd.slice(0, POST_DATA_KEEP)}… (${pd.length} chars)` : pd) : null,
      hasPostData: !!p.request.hasPostData,
      wallTime: p.wallTime ? p.wallTime * 1000 : Date.now(),
      startTs: p.timestamp,
      frameId: p.frameId,
      loaderId: p.loaderId,
    });
  }

  netResponse(p) {
    const e = this.byRequestId.get(p.requestId);
    if (!e) return;
    applyResponse(e, p.response);
    if (p.type) e.type = netType(p.type);
  }

  netFinished(p) {
    const e = this.byRequestId.get(p.requestId);
    if (!e) return;
    e.finished = true;
    e.endTs = p.timestamp;
    e.size = p.encodedDataLength;
  }

  netFailed(p) {
    const e = this.byRequestId.get(p.requestId);
    if (!e) return;
    e.finished = true;
    e.failed = true;
    e.endTs = p.timestamp;
    e.errorText = p.blockedReason ? `${p.errorText} (blocked: ${p.blockedReason})` : (p.canceled ? `${p.errorText} (canceled)` : p.errorText);
    if (p.type) e.type = netType(p.type);
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    for (const fn of [...this.listeners]) {
      try { fn('cctether.detached', {}); } catch { /* ignore */ }
    }
    this.listeners.clear();
  }
}

function applyResponse(e, r) {
  e.status = r.status;
  e.statusText = r.statusText ?? '';
  e.mimeType = r.mimeType ?? '';
  e.responseHeaders = r.headers ?? {};
  e.fromCache ||= !!(r.fromDiskCache || r.fromPrefetchCache || r.fromServiceWorker);
  if (r.fromServiceWorker) e.fromServiceWorker = true;
  e.remote = r.remoteIPAddress ? `${r.remoteIPAddress}${r.remotePort ? `:${r.remotePort}` : ''}` : '';
  e.protocol = r.protocol ?? '';
}

// ---- attach / detach -------------------------------------------------------------------------

async function attachErrorFor(tabId, msg) {
  if (/No tab with/i.test(msg)) return new ToolError('no_tab', `Tab ${tabId} no longer exists. Call list_tabs.`);
  if (/already attached/i.test(msg)) {
    return new ToolError('debugger_busy', `Another debugger is attached to tab ${tabId} (DevTools or another extension), so cctether can't control it. Ask the user to close DevTools on that tab or turn off the other debugging extension, then try again.`);
  }
  if (/Cannot access|Cannot attach|chrome:\/\/|chrome-extension:\/\//i.test(msg)) {
    let url = '';
    try { const t = await chrome.tabs.get(tabId); url = t.pendingUrl || t.url; } catch { /* gone */ }
    return new ToolError('restricted_url', `${restrictedMessage(url)} Navigate tab ${tabId} to a web page first, or use open_tab.`);
  }
  return new ToolError('internal', `Could not attach the debugger to tab ${tabId}: ${msg}`);
}

async function attach(tabId) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, PROTOCOL);
  } catch (e) {
    let msg = chromeErrorText(e);
    if (/already attached/i.test(msg)) {
      // Possibly our own attachment, left over from an earlier service-worker instance.
      try {
        await chrome.debugger.detach(target);
        await chrome.debugger.attach(target, PROTOCOL);
        msg = null;
      } catch (e2) {
        msg = /not attached/i.test(chromeErrorText(e2)) ? msg : chromeErrorText(e2);
      }
    }
    if (msg) throw await attachErrorFor(tabId, msg);
  }
  const s = new TabSession(tabId);
  sessions.set(tabId, s);
  notifyCount();
  // Console buffer starts empty; Runtime.enable replays messages logged before we attached.
  const steps = [
    s.send('Page.enable', {}, { timeoutMs: ENABLE_TIMEOUT_MS }),
    s.refreshFrame(),
    s.send('Runtime.enable', {}, { timeoutMs: ENABLE_TIMEOUT_MS }),
    s.send('Log.enable', {}, { timeoutMs: ENABLE_TIMEOUT_MS }),
    s.send('Network.enable', { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 5_000_000, maxPostDataSize: 65536 }, { timeoutMs: ENABLE_TIMEOUT_MS }),
    s.send('Emulation.setFocusEmulationEnabled', { enabled: true }, { timeoutMs: ENABLE_TIMEOUT_MS }),
  ];
  // If a dialog is already open, page-side enables hang until it closes: don't wait for them.
  await Promise.race([Promise.allSettled(steps), s.dialogSignal]);
  if (s.closed) throw detachedError(tabId);
  s.touch();
  return s;
}

/** Ensure the debugger is attached to the tab and return its session. */
export async function session(tabId) {
  const existing = sessions.get(tabId);
  if (existing && !existing.closed) { existing.touch(); return existing; }
  let p = attaching.get(tabId);
  if (!p) {
    p = attach(tabId).finally(() => attaching.delete(tabId));
    attaching.set(tabId, p);
  }
  return p;
}

/** The session for a tab if the debugger is attached, without attaching. */
export function existingSession(tabId) {
  const s = sessions.get(tabId);
  return s && !s.closed ? s : null;
}

export async function detach(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  s.dispose();
  notifyCount();
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
}

/** Detach from every tab (pause / disconnect). */
export async function detachAll() {
  await Promise.allSettled([...attaching.values()]);
  await Promise.allSettled([...sessions.keys()].map((id) => detach(id)));
}

function dropSession(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  s.dispose();
  notifyCount();
}

// ---- global listeners (registered at module load) ---------------------------------------------

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.sessionId || source.tabId === undefined) return; // child targets are not used
  const s = sessions.get(source.tabId);
  if (s && !s.closed) s.handleEvent(method, params ?? {});
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  dropSession(source.tabId);
  if (reason === 'canceled_by_user' && Date.now() - lastCancelNotice > 1000) {
    lastCancelNotice = Date.now();
    try { hooks.onUserCanceled?.(); } catch (e) { console.error(e); }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => dropSession(tabId));

// A tab that leaves the cctether group (or whose group is renamed) is no longer Claude's.
async function recheckScope(tabIds) {
  for (const id of tabIds) {
    if (!sessions.has(id)) continue;
    let tab;
    try { tab = await chrome.tabs.get(id); } catch { dropSession(id); continue; }
    if (!(await isShared(tab))) await detach(id);
  }
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if ('groupId' in info && sessions.has(tabId)) recheckScope([tabId]);
});
chrome.tabs.onAttached.addListener((tabId) => { if (sessions.has(tabId)) recheckScope([tabId]); });
chrome.tabGroups.onUpdated.addListener(() => { if (sessions.size) recheckScope([...sessions.keys()]); });
chrome.tabGroups.onRemoved.addListener(() => { if (sessions.size) recheckScope([...sessions.keys()]); });


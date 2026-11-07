// Service-worker application: owns the connection, settings, status and activity log, and routes
// tool calls from the server and commands from the UI pages (see shared/contract.js).

import { KEYS, DEFAULT_SETTINGS, DEFAULT_STATUS, ACTIVITY_MAX, MSG } from '../shared/contract.js';
import { parsePairingCode, keyFingerprint, displayServer, base64urlToBytes, bytesToBase64url } from '../shared/pairing.js';
import { Connection } from './connection.js';
import { runTool, ToolError, TOOL_NAMES } from './tools/index.js';
import { shareTab, unshareTab, tabInfo, countSharedTabs, onSharedTabsChanged } from './tabs.js';
import { detachAll, setDebuggerHooks } from './debugger.js';
import { updateActionIcon } from './badge.js';

const ALARM = 'cctether-check';
/** After the connection drops, keep debugger sessions this long in case it comes right back. */
const DETACH_GRACE_MS = 30_000;

const PAUSED_MESSAGES = {
  user: 'The user has paused cctether in the browser, so it will not act on any page. If you need the browser, ask the user to resume it (cctether toolbar icon → Resume).',
  debugger_canceled: 'The user stopped cctether by clicking "Cancel" on Chrome\'s debugging bar, which pauses cctether. If you need the browser, ask the user to resume it (cctether toolbar icon → Resume).',
};

let status = { ...DEFAULT_STATUS };
let settings = { ...DEFAULT_SETTINGS };
let activity = [];
let detachTimer = null;

const log = (...a) => console.log('[cctether]', ...a);

const connection = new Connection({
  onStatus: (patch) => setStatus(patch),
  onCall,
  getInfo,
  onConnectedChange,
  log,
});

// MV3: listeners must be registered synchronously when the worker starts.
chrome.runtime.onMessage.addListener(onMessage);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) ready.then(() => connection.tick());
});
chrome.storage.onChanged.addListener(onStorageChanged);
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
// Chrome doesn't close a WebSocket when the network goes away; react to the network events
// directly instead of waiting for the heartbeat to time out.
self.addEventListener('offline', () => { ready.then(() => connection.networkLost()); });
self.addEventListener('online', () => { ready.then(() => connection.networkBack()); });

const ready = init().catch((e) => log('init failed', e));

async function init() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get([KEYS.pairing, KEYS.settings]),
    chrome.storage.session.get([KEYS.status, KEYS.activity]),
  ]);
  settings = { ...DEFAULT_SETTINGS, ...(local[KEYS.settings] ?? {}) };
  activity = Array.isArray(session[KEYS.activity]) ? session[KEYS.activity] : [];
  const saved = session[KEYS.status] ?? null;
  status = { ...DEFAULT_STATUS, ...(saved ?? {}), attachedTabs: 0 };

  if (!(await chrome.alarms.get(ALARM))) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 });
  setDebuggerHooks({
    onUserCanceled: () => setPaused(true, 'debugger_canceled'),
    onAttachedCountChanged: (n) => setStatus({ attachedTabs: n }),
  });
  onSharedTabsChanged(refreshSharedCount);
  await refreshSharedCount();

  updateActionIcon(status, settings).catch(() => {});
  const pairing = local[KEYS.pairing];
  if (!pairing) {
    setStatus({ conn: 'unpaired', server: null, error: null, retryAt: null, serverVersion: null });
    return;
  }
  connection.start(
    { url: pairing.url, key: base64urlToBytes(pairing.key) },
    {
      retryAt: saved?.conn === 'disconnected' ? saved.retryAt : null,
      replaced: saved?.conn === 'replaced',
    },
  );
}

function setStatus(patch) {
  const next = { ...status, ...patch };
  if (patch.conn && patch.conn !== status.conn) next.since = Date.now();
  status = next;
  chrome.storage.session.set({ [KEYS.status]: status }).catch(() => {});
  updateActionIcon(status, settings).catch(() => {});
}

async function refreshSharedCount() {
  try {
    const n = await countSharedTabs();
    if (n !== status.sharedTabs) setStatus({ sharedTabs: n });
  } catch {}
}

function getInfo() {
  const ua = navigator.userAgentData;
  const brands = ua?.brands ?? [];
  const brand = brands.find((b) => !/Not.?A.?Brand|Chromium/i.test(b.brand)) ?? brands.find((b) => /Chromium/i.test(b.brand));
  return {
    extension: chrome.runtime.getManifest().version,
    browser: brand ? `${brand.brand} ${brand.version}` : (navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? 'unknown'),
    platform: ua?.platform ?? navigator.platform ?? 'unknown',
  };
}

function onConnectedChange(connected) {
  clearTimeout(detachTimer);
  detachTimer = null;
  if (!connected) {
    detachTimer = setTimeout(() => {
      if (!connection.connected) detachAll().catch(() => {});
    }, DETACH_GRACE_MS);
  }
}

// --- tool calls from the server ----------------------------------------------------------

async function onCall(tool, args) {
  await ready;
  if (!TOOL_NAMES.includes(tool)) {
    return { ok: false, error: { code: 'bad_args', message: `Unknown tool "${String(tool).slice(0, 50)}". Update the cctether extension?` } };
  }
  if (settings.paused) {
    recordActivity(tool, null, false, 'paused');
    return { ok: false, error: { code: 'paused', message: PAUSED_MESSAGES[settings.pausedReason] ?? PAUSED_MESSAGES.user } };
  }
  try {
    const r = await runTool(tool, args);
    recordActivity(tool, r?.tab ?? null, true);
    return { ok: true, data: { content: r.content } };
  } catch (e) {
    const known = e instanceof ToolError;
    recordActivity(tool, e?.tab ?? null, false, known ? e.code : 'internal');
    if (!known) log(`tool ${tool} failed`, e);
    return {
      ok: false,
      error: known
        ? { code: e.code, message: e.message }
        : { code: 'internal', message: `Unexpected error in the cctether extension: ${e?.message ?? e}` },
    };
  }
}

function recordActivity(tool, tab, ok, error) {
  let host = '';
  try { host = tab?.url ? new URL(tab.url).host : ''; } catch {}
  const entry = { t: Date.now(), tool, tab: tab ? { id: tab.id, title: String(tab.title ?? '').slice(0, 200), host } : null, ok };
  if (error) entry.error = error;
  activity = [entry, ...activity].slice(0, ACTIVITY_MAX);
  chrome.storage.session.set({ [KEYS.activity]: activity }).catch(() => {});
}

// --- settings ----------------------------------------------------------------------------

async function setPaused(paused, reason) {
  // Merge into what's stored: the settings page writes `lang` the same way.
  const stored = (await chrome.storage.local.get(KEYS.settings))[KEYS.settings] ?? {};
  settings = { ...DEFAULT_SETTINGS, ...stored, paused, pausedReason: paused ? reason : null };
  await chrome.storage.local.set({ [KEYS.settings]: settings });
  if (paused) await detachAll().catch(() => {});
  updateActionIcon(status, settings).catch(() => {});
}

function onStorageChanged(changes, area) {
  if (area === 'local' && changes[KEYS.settings]) {
    settings = { ...DEFAULT_SETTINGS, ...(changes[KEYS.settings].newValue ?? {}) };
    updateActionIcon(status, settings).catch(() => {});
  }
}

// --- messages from the popup / options pages ---------------------------------------------

function onMessage(msg, sender, sendResponse) {
  // Only our own extension pages may send commands.
  if (sender.id !== chrome.runtime.id || !String(sender.url ?? '').startsWith(`chrome-extension://${chrome.runtime.id}/`)) return false;
  handleUiMessage(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: 'internal', detail: String(e?.message ?? e) }));
  return true;
}

const validTabId = (id) => Number.isInteger(id) && id >= 0;

async function handleUiMessage(msg) {
  await ready;
  switch (msg?.type) {
    case MSG.pair: {
      const p = parsePairingCode(msg.code);
      if (!p.ok) return { ok: false, error: p.error };
      const fingerprint = await keyFingerprint(p.key);
      await chrome.storage.local.set({
        [KEYS.pairing]: { url: p.url, key: bytesToBase64url(p.key), fingerprint, pairedAt: Date.now() },
      });
      connection.start({ url: p.url, key: p.key });
      return { ok: true, fingerprint, server: displayServer(p.url) };
    }
    case MSG.unpair:
      connection.stop();
      await chrome.storage.local.remove(KEYS.pairing);
      await detachAll().catch(() => {});
      return { ok: true };
    case MSG.setPaused:
      await setPaused(msg.paused === true, 'user');
      return { ok: true };
    case MSG.reconnect:
      connection.reconnectNow();
      return { ok: true };
    case MSG.shareTab:
    case MSG.unshareTab: {
      if (!validTabId(msg.tabId)) return { ok: false, error: 'no_tab' };
      try {
        await (msg.type === MSG.shareTab ? shareTab(msg.tabId) : unshareTab(msg.tabId));
      } catch (e) {
        return { ok: false, error: e?.code ?? 'internal', detail: String(e?.message ?? e) };
      }
      await refreshSharedCount();
      return { ok: true };
    }
    case MSG.tabInfo: {
      if (!validTabId(msg.tabId)) return { ok: false, error: 'no_tab' };
      try {
        return { ok: true, ...(await tabInfo(msg.tabId)) };
      } catch (e) {
        return { ok: false, error: e?.code ?? 'no_tab' };
      }
    }
    default:
      return { ok: false, error: 'unknown_message' };
  }
}

// Debug/test hook, reachable only through DevTools / CDP on this service worker.
self.cctether = { runTool, getStatus: () => status, getSettings: () => settings };

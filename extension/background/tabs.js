// Tab scope: only tabs in a tab group titled GROUP_TITLE ("cctether") may be used (SPEC D10).
// Membership is checked from the live tab/group state on every call, never cached (SPEC §11.5).

import { GROUP_TITLE } from '../shared/contract.js';
import { ToolError } from './tools/errors.js';

const GROUP_COLOR = 'cyan';
const CURRENT_KEY = 'currentTab'; // chrome.storage.session
const NO_GROUP = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE

const SHARE_HINT = 'ask the user to share it (cctether toolbar button → "Share this tab", or drag it into the "cctether" tab group), or open the page yourself with open_tab';

// ---------------------------------------------------------------------------------------------
// Restricted pages

const RESTRICTED_SCHEMES = new Set([
  'chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:', 'chrome-devtools:',
  'devtools:', 'edge:', 'brave:', 'opera:', 'vivaldi:', 'view-source:', 'chrome-error:',
]);

/** Pages the debugger may not (or must not) touch. */
export async function isRestrictedUrl(url) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'about:') return u.pathname !== 'blank';
  if (RESTRICTED_SCHEMES.has(u.protocol)) return true;
  if (u.protocol === 'file:') {
    try { return !(await chrome.extension.isAllowedFileSchemeAccess()); } catch { return true; }
  }
  const host = u.hostname.toLowerCase();
  if (host === 'chromewebstore.google.com') return true;
  if (host === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
  if (host === 'microsoftedge.microsoft.com' && u.pathname.startsWith('/addons')) return true;
  return false;
}

export function restrictedMessage(url) {
  let what = 'this kind of page';
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') {
      return 'Local files (file://) are not available: the user has not turned on "Allow access to file URLs" for cctether on chrome://extensions.';
    }
    what = u.protocol === 'https:' || u.protocol === 'http:' ? `${u.host} (the extension store)` : `${u.protocol}// pages`;
  } catch { /* keep default */ }
  return `Chrome does not let extensions control ${what}. Use a normal web page (http/https) instead.`;
}

// ---------------------------------------------------------------------------------------------
// Membership

/** Is this tab in a group titled "cctether"? */
export async function isShared(tab) {
  if (!tab || tab.groupId === undefined || tab.groupId === NO_GROUP) return false;
  try {
    const g = await chrome.tabGroups.get(tab.groupId);
    return g.title === GROUP_TITLE;
  } catch {
    return false;
  }
}

async function sharedGroups(windowId) {
  const groups = await chrome.tabGroups.query(windowId === undefined ? {} : { windowId });
  return groups.filter((g) => g.title === GROUP_TITLE);
}

/** All tabs currently in a cctether group, in window/tab order. */
export async function sharedTabs() {
  const groups = await sharedGroups();
  if (!groups.length) return [];
  const ids = new Set(groups.map((g) => g.id));
  const tabs = await chrome.tabs.query({});
  return tabs.filter((t) => ids.has(t.groupId));
}

export async function countSharedTabs() {
  return (await sharedTabs()).length;
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw new ToolError('no_tab', `There is no tab with id ${tabId} (it may have been closed). Call list_tabs to see the shared tabs.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Current tab

let currentTabId; // undefined = not loaded from storage yet; null = none

export function setCurrentTab(tabId) {
  currentTabId = Number.isInteger(tabId) ? tabId : null;
  chrome.storage.session.set({ [CURRENT_KEY]: currentTabId }).catch(() => {});
}

export async function getCurrentTab() {
  if (currentTabId === undefined) {
    try {
      const r = await chrome.storage.session.get(CURRENT_KEY);
      if (currentTabId === undefined) currentTabId = Number.isInteger(r[CURRENT_KEY]) ? r[CURRENT_KEY] : null;
    } catch {
      currentTabId = null;
    }
  }
  return currentTabId;
}

/**
 * Resolve the `tab` argument of a tool (SPEC §5.2 参数约定). Returns a chrome.tabs.Tab that is
 * shared. Throws ToolError no_tab / not_shared / bad_args.
 */
export async function resolveTab(tabArg) {
  if (tabArg !== undefined && tabArg !== null) {
    if (!Number.isInteger(tabArg) || tabArg < 0) {
      throw new ToolError('bad_args', '`tab` must be a tab id (an integer) from list_tabs.');
    }
    const tab = await getTab(tabArg);
    if (!(await isShared(tab))) {
      throw new ToolError('not_shared', `Tab ${tabArg} is not shared with cctether, so it can't be used. To use it, ${SHARE_HINT}.`);
    }
    return tab;
  }
  const shared = await sharedTabs();
  if (!shared.length) {
    throw new ToolError('no_tab', `No tab is shared with cctether yet. Open a page with open_tab, or ${SHARE_HINT.replace('share it', 'share a tab')}.`);
  }
  const cur = await getCurrentTab();
  if (cur != null) {
    const t = shared.find((x) => x.id === cur);
    if (t) return t;
  }
  let win = null;
  try { win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); } catch { /* none */ }
  const active = win && shared.find((t) => t.active && t.windowId === win.id);
  if (active) return active;
  if (shared.length === 1) return shared[0];
  throw new ToolError('no_tab', `${shared.length} tabs are shared and none of them is the current tab. Call list_tabs and pass \`tab\`.`);
}

// ---------------------------------------------------------------------------------------------
// Group changes (serialised so two calls can't create two groups in one window)

let groupLock = Promise.resolve();
function withGroupLock(fn) {
  const p = groupLock.then(fn, fn);
  groupLock = p.catch(() => {});
  return p;
}

async function addToGroup(tab) {
  if (tab.pinned) await chrome.tabs.update(tab.id, { pinned: false });
  const [g] = await sharedGroups(tab.windowId);
  if (g) {
    await chrome.tabs.group({ groupId: g.id, tabIds: [tab.id] });
    return g.id;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
  return groupId;
}

function groupError(e) {
  const msg = String(e?.message ?? e);
  if (/normal window/i.test(msg)) {
    return new ToolError('internal', 'Tabs in pop-up or app windows cannot be put in a tab group. Open the page in a normal browser window.');
  }
  return new ToolError('internal', `Could not put the tab into the cctether group: ${msg}`);
}

/** Put a tab into its window's cctether group (created if missing). */
export async function shareTab(tabId) {
  const tab = await getTab(tabId);
  const url = tab.pendingUrl || tab.url;
  if (await isRestrictedUrl(url)) throw new ToolError('restricted_url', restrictedMessage(url));
  if (await isShared(tab)) return;
  await withGroupLock(async () => {
    const fresh = await getTab(tabId);
    if (await isShared(fresh)) return;
    try { await addToGroup(fresh); } catch (e) { throw groupError(e); }
  });
}

/** Take a tab out of the cctether group. */
export async function unshareTab(tabId) {
  const tab = await getTab(tabId);
  if (!(await isShared(tab))) return;
  await withGroupLock(() => chrome.tabs.ungroup(tabId));
}

export async function tabInfo(tabId) {
  const tab = await getTab(tabId);
  return { shared: await isShared(tab), restricted: await isRestrictedUrl(tab.pendingUrl || tab.url) };
}

/**
 * Open a new tab in the cctether group: in the window that already has the group (preferring
 * the last-focused one), else the last-focused normal window, else a new window.
 */
export async function openSharedTab(url, active) {
  return withGroupLock(async () => {
    let last = null;
    try { last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); } catch { /* none */ }
    if (last && last.type !== 'normal') last = null;
    const groups = await sharedGroups();
    const g = groups.find((x) => x.windowId === last?.id) ?? groups[0];
    const windowId = g ? g.windowId : last?.id;
    let tab;
    if (windowId === undefined) {
      const w = await chrome.windows.create({ url, focused: !!active, type: 'normal' });
      tab = w.tabs[0];
    } else {
      tab = await chrome.tabs.create({ windowId, url, active: !!active });
    }
    try {
      if (g) await chrome.tabs.group({ groupId: g.id, tabIds: [tab.id] });
      else await addToGroup(tab);
    } catch (e) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw groupError(e);
    }
    if (active) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return chrome.tabs.get(tab.id);
  });
}

// ---------------------------------------------------------------------------------------------
// Change notifications (registered at module load so they work after a service-worker restart)

const changeCallbacks = new Set();
let debounceTimer = null;

function changed() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    for (const cb of changeCallbacks) {
      try { cb(); } catch (e) { console.error('onSharedTabsChanged callback failed', e); }
    }
  }, 200);
}

/** Call cb() (debounced) whenever the set of shared tabs may have changed. */
export function onSharedTabsChanged(cb) {
  changeCallbacks.add(cb);
  return () => changeCallbacks.delete(cb);
}

chrome.tabs.onCreated.addListener(changed);
chrome.tabs.onRemoved.addListener((tabId) => {
  if (currentTabId === tabId) setCurrentTab(null);
  changed();
});
chrome.tabs.onUpdated.addListener((_id, info) => {
  if ('groupId' in info || 'url' in info) changed();
});
chrome.tabs.onAttached.addListener(changed);
chrome.tabs.onDetached.addListener(changed);
chrome.tabs.onReplaced.addListener(changed);
chrome.tabGroups.onCreated.addListener(changed);
chrome.tabGroups.onUpdated.addListener(changed);
chrome.tabGroups.onRemoved.addListener(changed);

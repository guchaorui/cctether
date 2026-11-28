// Tools that work on the browser rather than inside a page: tabs and extensions.

import { ToolError } from './errors.js';
import { q, clip, normalizeUrl, withTimeout } from './util.js';
import {
  sharedTabs, resolveTab, setCurrentTab, openSharedTab, isShared, isRestrictedUrl, restrictedMessage, scopeEventCount,
} from '../tabs.js';
import { existingSession, session } from '../debugger.js';

export async function tabSummary(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return { id: t.id, title: t.title ?? '', url: t.pendingUrl || t.url || '' };
  } catch {
    return { id: tabId, title: '', url: '' };
  }
}

export async function browserVersion() {
  const uad = navigator.userAgentData;
  try {
    const h = await uad.getHighEntropyValues(['fullVersionList']);
    const brands = (h.fullVersionList ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand));
    const b = brands.find((x) => x.brand !== 'Chromium') ?? brands[0];
    return `${b.brand} ${b.version} on ${uad.platform || 'unknown OS'}`;
  } catch {
    const m = navigator.userAgent.match(/Chrome\/([\d.]+)/);
    return `Chrome ${m?.[1] ?? '(unknown version)'}`;
  }
}

export function isMac() {
  return navigator.userAgentData?.platform === 'macOS' || /Mac/.test(navigator.platform ?? '');
}

/** Wait until a tab reports status "complete" (or the timeout passes). */
export function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(ok);
    };
    const onUpdated = (id, info, tab) => {
      if (id === tabId && info.status === 'complete' && !tab.pendingUrl) finish(true);
    };
    const onRemoved = (id) => { if (id === tabId) finish(false); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete' && !t.pendingUrl && t.url && t.url !== '') finish(true);
    }, () => finish(false));
  });
}

// ---- list_tabs ---------------------------------------------------------------------------------

export async function listTabs() {
  const tabs = await sharedTabs();
  let current = null;
  try { current = (await resolveTab(undefined)).id; } catch { /* none */ }
  const lines = [];
  if (!tabs.length) {
    lines.push('No tabs are shared with cctether. Open a page with open_tab, or ask the user to share a tab (cctether toolbar button → "Share this tab", or drag the tab into the "cctether" tab group).');
  } else {
    lines.push(`Shared tabs (${tabs.length}); "current" is the tab used when you don't pass \`tab\`:`);
    for (const t of tabs) {
      const flags = [];
      if (t.id === current) flags.push('current');
      if (t.active) flags.push('visible to the user');
      if (t.status === 'loading') flags.push('loading');
      if (t.discarded) flags.push('asleep (discarded)');
      if (existingSession(t.id)?.dialog) flags.push(`${existingSession(t.id).dialog.type} dialog open`);
      const vp = existingSession(t.id)?.viewport;
      if (vp) flags.push(`viewport override ${vp.width}×${vp.height}`);
      const scheme = existingSession(t.id)?.colorScheme;
      if (scheme) flags.push(`color scheme ${scheme}`);
      const by = mutedBy(t.mutedInfo);
      if (by !== undefined) flags.push(by === 'cctether' ? 'muted' : `muted ${MUTED_BY[by]}`);
      if (t.audible) flags.push('playing sound');
      if (await isRestrictedUrl(t.pendingUrl || t.url)) flags.push('restricted page, navigate it first');
      lines.push(`- tab ${t.id}: ${q(t.title || '(no title)', 100)} ${clip(t.pendingUrl || t.url || '', 300)}${flags.length ? ` (${flags.join(', ')})` : ''}`);
    }
  }
  lines.push(`Browser: ${await browserVersion()}. cctether extension ${chrome.runtime.getManifest().version}.`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ---- open_tab / close_tab ---------------------------------------------------------------------

export async function openTab(args, { paused = () => false } = {}) {
  const url = normalizeUrl(args.url ?? 'about:blank');
  if (await isRestrictedUrl(url)) throw new ToolError('restricted_url', restrictedMessage(url));
  const active = args.active === true;
  const muted = args.muted === true; // false or left out: Chrome's own sound settings apply, untouched
  const blank = url === 'about:blank';
  const tab = await openSharedTab('about:blank', active);
  setCurrentTab(tab.id);
  if (muted) await muteNewTab(tab.id, url, paused);
  if (!blank) {
    // Attach before loading the page so its requests and console output are recorded from the start.
    try { await session(tab.id); } catch { /* recorded from the first tool call that attaches instead */ }
    // Checked again right before loading, with nothing awaited after: the tab may have left the
    // group, cctether been paused, or the mute been undone while the debugger attached.
    const t0 = await freshShared(tab.id).catch(scopeStop(tab.id, url));
    if (paused()) throw notLoaded(tab.id, url, 'cctether was paused', 'paused');
    if (muted && mutedBy(t0.mutedInfo) === undefined) throw notLoaded(tab.id, url, 'its mute was undone (by an extension) before the page loaded', 'internal');
    await chrome.tabs.update(tab.id, { url });
  }
  const loaded = await waitTabComplete(tab.id, 30000);
  const t = await tabSummary(tab.id);
  const where = active ? 'in the foreground' : 'in the background (the user\'s view did not change)';
  let sound = '';
  if (muted) {
    const now = await chrome.tabs.get(tab.id).then((x) => mutedBy(x.mutedInfo), () => undefined);
    sound = now === undefined ? ', but something unmuted it while it loaded' : ', muted';
  }
  const text = `Opened tab ${t.id} ${where}${sound}: ${q(t.title || '(no title)', 100)} ${t.url}`
    + `${loaded ? '' : '. It is still loading after 30 s; use wait_for or read_page later'}. It is now the current tab.`;
  return { content: [{ type: 'text', text }], tab: t };
}

export async function closeTab(args) {
  const tab = await resolveTab(args.tab);
  const t = await tabSummary(tab.id);
  await chrome.tabs.remove(tab.id);
  return { content: [{ type: 'text', text: `Closed tab ${t.id}: ${q(t.title, 100)} ${t.url}` }], tab: t };
}

// ---- mute_tab ----------------------------------------------------------------------------------
// Chrome's own tab mute (SPEC §5.2 静音). Once an extension has set a tab's mute state (either
// way), Chrome stops applying the site's sound setting to that tab until it closes. So cctether
// writes only when the state has to change, unmutes only a mute it set itself, and never touches
// a tab outside the group (a tab it muted stays muted if it leaves).

const MUTED_BY = {
  cctether: 'by cctether',
  user: 'by the user (or the site\'s sound setting)',
  extension: 'by another extension',
  other: 'by Chrome (not by cctether)',
};

/**
 * Who muted a tab, from its mutedInfo: 'cctether' | 'user' | 'extension' | 'other', or undefined
 * when it is not muted.
 */
export function mutedBy(info, selfId = chrome.runtime.id) {
  if (!info?.muted) return undefined;
  if (info.reason === 'extension') return info.extensionId === selfId ? 'cctether' : 'extension';
  return info.reason === 'user' ? 'user' : 'other';
}

/**
 * Re-read a tab right before writing to it, and check it is still shared: the tab, its group, then
 * the tab again (it may have left the group while the group was read). If a tab or group event
 * came in meanwhile (a rename keeps the group id), all of it again. Returns the last read, so the
 * caller decides from it (mutedInfo too) and writes with nothing awaited in between. Chrome can't
 * check and write in one step: what remains is the time of one call.
 */
async function freshShared(tabId) {
  const get = () => chrome.tabs.get(tabId).catch(() => { throw new ToolError('no_tab', `Tab ${tabId} was closed.`); });
  for (let i = 0; i < 5; i++) {
    const n = scopeEventCount();
    const t = await get();
    const shared = await isShared(t);
    const again = await get();
    if (!shared || again.groupId !== t.groupId) throw new ToolError('not_shared', `Tab ${tabId} left the cctether group, so cctether did not change it.`);
    if (scopeEventCount() === n) return again;
  }
  throw new ToolError('busy', `Tab groups kept changing while cctether checked tab ${tabId}, so it did not change it. Try again in a moment.`);
}

/** open_tab stopped before loading the page: the tab stays on about:blank (unless it was closed). */
const SCOPE_WHY = { no_tab: 'it was closed', not_shared: 'it left the cctether group', busy: 'tab groups kept changing while cctether checked it' };
const scopeStop = (tabId, url) => (e) => { throw e.code in SCOPE_WHY ? notLoaded(tabId, url, SCOPE_WHY[e.code], e.code) : e; };

function notLoaded(tabId, url, why, code) {
  const closed = code === 'no_tab';
  const e = new ToolError(code, `Opened tab ${tabId} but did not load ${clip(url, 300)}: ${why}.${closed ? '' : ' It shows about:blank.'}`);
  e.tab = { id: tabId, title: '', url: closed ? '' : 'about:blank' };
  return e;
}

/**
 * open_tab with muted: mute the blank tab before it loads the page (unless something already
 * muted it: no write then); if it isn't muted afterwards, don't load the page.
 */
async function muteNewTab(tabId, url, paused) {
  const t = await freshShared(tabId).catch(scopeStop(tabId, url));
  if (mutedBy(t.mutedInfo) === undefined) {
    if (paused()) throw notLoaded(tabId, url, 'cctether was paused', 'paused');
    await chrome.tabs.update(tabId, { muted: true }).catch(() => {});
  }
  const now = await chrome.tabs.get(tabId).then((x) => mutedBy(x.mutedInfo), () => undefined);
  if (now === undefined) throw notLoaded(tabId, url, 'Chrome did not mute it. Try mute_tab on it, then navigate; or close it with close_tab', 'internal');
}

export async function muteTab(args, { paused = () => false } = {}) {
  const want = args.muted !== false;
  const { id } = await resolveTab(args.tab);
  const summary = await tabSummary(id);
  // Decided from this read, and written with nothing awaited in between.
  const t = await freshShared(id);
  const by = mutedBy(t.mutedInfo);
  const done = (text) => ({ content: [{ type: 'text', text }], tab: summary });
  // Nothing to change: no write (it would make cctether the owner of the tab's mute state).
  if (want && by !== undefined) return done(`Tab ${id} was already muted (${MUTED_BY[by]}); it stays muted.`);
  if (!want && by === undefined) return done(`Tab ${id} was not muted; nothing changed.`);
  if (!want && by !== 'cctether') {
    const e = new ToolError('not_own_mute', `Did not unmute tab ${id}: it was muted ${MUTED_BY[by]}, and cctether only undoes its own mute. `
      + (by === 'user' ? 'If the user wants to hear it, ask them to unmute it in Chrome (right-click the tab → Unmute site).' : 'Ask the user to unmute it in Chrome.'));
    e.tab = summary;
    throw e;
  }
  if (paused()) throw new ToolError('paused', 'Not done: the user paused cctether.');
  await chrome.tabs.update(id, { muted: want });
  const after = await chrome.tabs.get(id);
  if (!(await isShared(after))) {
    const e = new ToolError('not_shared', `Tab ${id} left the cctether group just as it was ${want ? 'muted' : 'unmuted'}; it is ${after.mutedInfo?.muted ? 'muted' : 'not muted'} now.`);
    e.tab = summary;
    throw e;
  }
  const now = mutedBy(after.mutedInfo);
  if ((now !== undefined) !== want) {
    const e = new ToolError('internal', `Asked Chrome to ${want ? 'mute' : 'unmute'} tab ${id}, but it is ${now === undefined ? 'not muted' : `muted ${MUTED_BY[now]}`}.`);
    e.tab = summary;
    throw e;
  }
  return done(want ? `Muted tab ${id}: no sound from it reaches the user, also after it navigates.`
    : `Unmuted tab ${id} (it was muted by cctether).`);
}

// ---- extensions ------------------------------------------------------------------------------

const TYPE_LABEL = {
  hosted_app: 'hosted app', packaged_app: 'app', legacy_packaged_app: 'legacy app', theme: 'theme', login_screen_extension: 'login screen extension',
};

function extLine(e) {
  const bits = [e.enabled ? 'enabled' : `disabled${e.disabledReason && e.disabledReason !== 'unknown' ? ` (${e.disabledReason})` : ''}`];
  if (e.installType === 'development') bits.push('unpacked');
  else if (e.installType === 'admin') bits.push('installed by policy');
  if (TYPE_LABEL[e.type]) bits.push(TYPE_LABEL[e.type]);
  if (e.id === chrome.runtime.id) bits.push('this is cctether itself');
  return `- ${q(e.name, 80)} v${e.version} id=${e.id}: ${bits.join(', ')}`;
}

export async function listExtensions() {
  const all = await chrome.management.getAll();
  all.sort((a, b) => (a.installType === 'development' ? 0 : 1) - (b.installType === 'development' ? 0 : 1) || a.name.localeCompare(b.name));
  const n = all.filter((e) => e.installType === 'development').length;
  const text = [`${all.length} extension${all.length === 1 ? '' : 's'} installed (${n} unpacked):`, ...all.map(extLine)].join('\n');
  return { content: [{ type: 'text', text }] };
}

export async function reloadExtension(args) {
  const id = args.id;
  if (id === chrome.runtime.id) {
    throw new ToolError('bad_args', 'That is cctether itself. It can\'t reload itself: the connection to you would drop. Ask the user to click the reload button for cctether on chrome://extensions.');
  }
  let info;
  try { info = await chrome.management.get(id); } catch {
    throw new ToolError('not_found', `No installed extension has the id ${id}. Call list_extensions to see the ids.`);
  }
  if (info.mayDisable === false) {
    throw new ToolError('bad_args', `${q(info.name)} is installed by policy and can't be turned off and on.`);
  }
  try {
    if (info.enabled) await withTimeout(chrome.management.setEnabled(id, false), 10000, new Error('timed out disabling'));
    await withTimeout(chrome.management.setEnabled(id, true), 10000, new Error('timed out enabling'));
  } catch (e) {
    throw new ToolError('internal', `Could not reload ${q(info.name)}: ${e?.message ?? e}. Ask the user to click its reload button on chrome://extensions.`);
  }
  const now = await chrome.management.get(id);
  const text = `Reloaded ${q(now.name)} v${now.version} (${now.enabled ? 'enabled' : 'still disabled'}) by turning it off and on.`
    + ' Its code (background, content scripts, pages) was read again from disk.'
    + ' Changes to manifest.json are NOT picked up this way: if you changed the manifest, ask the user to click the reload button for this extension on chrome://extensions.'
    + ' Tabs that were already open keep the old content scripts until they are reloaded (navigate with action: "reload").';
  return { content: [{ type: 'text', text }] };
}

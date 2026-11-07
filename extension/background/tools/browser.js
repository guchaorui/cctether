// Tools that work on the browser rather than inside a page: tabs and extensions.

import { ToolError } from './errors.js';
import { q, clip, normalizeUrl, withTimeout } from './util.js';
import {
  sharedTabs, resolveTab, setCurrentTab, openSharedTab, isRestrictedUrl, restrictedMessage,
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
      if (await isRestrictedUrl(t.pendingUrl || t.url)) flags.push('restricted page, navigate it first');
      lines.push(`- tab ${t.id}: ${q(t.title || '(no title)', 100)} ${clip(t.pendingUrl || t.url || '', 300)}${flags.length ? ` (${flags.join(', ')})` : ''}`);
    }
  }
  lines.push(`Browser: ${await browserVersion()}. cctether extension ${chrome.runtime.getManifest().version}.`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// ---- open_tab / close_tab ---------------------------------------------------------------------

export async function openTab(args) {
  const url = normalizeUrl(args.url ?? 'about:blank');
  if (await isRestrictedUrl(url)) throw new ToolError('restricted_url', restrictedMessage(url));
  const active = args.active === true;
  const blank = url === 'about:blank';
  const tab = await openSharedTab('about:blank', active);
  setCurrentTab(tab.id);
  if (!blank) {
    // Attach before loading the page so its requests and console output are recorded from the start.
    try { await session(tab.id); } catch { /* recorded from the first tool call that attaches instead */ }
    await chrome.tabs.update(tab.id, { url });
  }
  const loaded = await waitTabComplete(tab.id, 30000);
  const t = await tabSummary(tab.id);
  const where = active ? 'in the foreground' : 'in the background (the user\'s view did not change)';
  const text = `Opened tab ${t.id} ${where}: ${q(t.title || '(no title)', 100)} ${t.url}`
    + `${loaded ? '' : '. It is still loading after 30 s; use wait_for or read_page later'}. It is now the current tab.`;
  return { content: [{ type: 'text', text }], tab: t };
}

export async function closeTab(args) {
  const tab = await resolveTab(args.tab);
  const t = await tabSummary(tab.id);
  await chrome.tabs.remove(tab.id);
  return { content: [{ type: 'text', text: `Closed tab ${t.id}: ${q(t.title, 100)} ${t.url}` }], tab: t };
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

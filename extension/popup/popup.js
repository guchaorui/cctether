// Toolbar popup: connection state, the current tab, pause, recent activity.

import {
  h, rich, icon, setChildren, applyStatic, statusView, retryText, stateBadge,
  loadState, onStateChange, send, languageFor, setDocumentLanguage, MSG, REPO_URL,
} from '../shared/ui.js';
import { formatClock } from '../shared/i18n.js';

const ACTIVITY_SHOWN = 8;
const app = document.getElementById('app');
const settingsBtn = document.getElementById('open-settings');

let state = null;      // { settings, pairing, status, activity }
let tab = null;        // chrome.tabs.Tab for the tab the popup was opened on
let tabInfo = null;    // { shared, restricted } from the service worker
let tabBusy = false;
let tabFailed = false;
let busyAction = null;
let retryEl = null;

// The popup normally acts on the active tab. `?tabId=` lets tests render it for a specific tab.
const forcedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null;

async function main() {
  settingsBtn.append(icon('settings', { size: 18 }));
  settingsBtn.addEventListener('click', openSettings);
  state = await loadState();
  await refreshTab();
  render();
  onStateChange(async (keys) => {
    state = await loadState();
    if (keys.has('status')) await refreshTab();
    render();
  });
  setInterval(tick, 500);
}

async function refreshTab() {
  try {
    tab = forcedTabId
      ? await chrome.tabs.get(forcedTabId)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0] ?? null;
  } catch {
    tab = null;
  }
  if (!tab || !state?.pairing) { tabInfo = null; return; }
  const r = await send(MSG.tabInfo, { tabId: tab.id });
  tabInfo = r.ok ? { shared: !!r.shared, restricted: !!r.restricted } : null;
}

function tick() {
  if (!retryEl || !state) return;
  const { t } = languageFor(state.settings);
  retryEl.textContent = retryText(Number(retryEl.dataset.at), t);
}

// ---------------------------------------------------------------------------------------------

function render() {
  const { lang, t } = languageFor(state.settings);
  setDocumentLanguage(lang, t);
  applyStatic(document, t);

  const view = statusView(state.status, state.settings, state.pairing, t, chrome.runtime.id);
  const paired = view.kind !== 'unpaired';
  const showDebugNote = view.kind === 'connected' && state.status.attachedTabs > 0;

  retryEl = null;
  setChildren(app,
    renderStatus(view, t, showDebugNote),
    paired && renderTab(t),
    paired && renderActivity(t, lang),
  );
  document.body.dataset.state = view.kind;
  fitHeight();
}

// Chrome caps popups at 600px. Drop the oldest activity rows rather than make the popup scroll.
const MAX_HEIGHT = 600;
function fitHeight() {
  const rows = [...app.querySelectorAll('.log-row')];
  while (rows.length > 3 && document.documentElement.getBoundingClientRect().height > MAX_HEIGHT) rows.pop().remove();
}

function renderStatus(view, t, debugNote = false) {
  const head = h('div', { class: 'status-head' },
    stateBadge(view),
    h('div', { class: 'status-text' },
      h('h1', { class: 'status-title' }, view.title),
      view.server && h('p', { class: 'status-server', title: view.server }, view.server),
      view.link && h('p', { class: 'status-link' },
        h('span', { class: `dot ${view.link.up ? 'tone-ok' : 'tone-neutral'}` }), h('span', {}, view.link.text)),
    ),
    ...view.actions.filter((a) => a.kind === 'ghost').map((a) => actionButton(a, 'btn-sm')),
  );

  const footActions = view.actions.filter((a) => a.kind !== 'ghost');
  let retry = null;
  if (view.retryAt) {
    retry = h('span', { class: 'retry', 'data-at': view.retryAt, 'aria-live': 'off' }, retryText(view.retryAt, t));
    retryEl = retry;
  }

  return h('section', { class: `status tone-${view.tone}`, 'data-kind': view.kind },
    head,
    view.body && h('p', { class: 'status-body' }, rich(view.body)),
    view.kind === 'unpaired' && h('ol', { class: 'steps' },
      ['state.unpaired.step1', 'state.unpaired.step2', 'state.unpaired.step3'].map((k, i) =>
        h('li', {}, h('span', { class: 'step-n' }, String(i + 1)), h('span', {}, rich(t(k)))))),
    view.detail && h('p', { class: 'status-detail' }, view.detail),
    (footActions.length || retry) && h('div', { class: 'status-foot' },
      footActions.map((a) => actionButton(a)),
      retry && h('span', { class: 'retry-wrap' }, icon('clock', { size: 13 }), retry),
    ),
    debugNote && h('p', { class: 'status-note' }, icon('info', { size: 14 }), h('span', {}, t('debugbar.note'))),
  );
}

function actionButton(a, extra = '') {
  return h('button', {
    type: 'button',
    class: `btn btn-${a.kind} ${extra}`.trim(),
    disabled: busyAction === a.id,
    onclick: () => runAction(a.id),
  }, a.icon && icon(a.icon, { size: 14 }), a.label);
}

async function runAction(id) {
  switch (id) {
    case 'setup':
    case 'pairAgain':
      return openSettings();
    case 'getUpdate':
      await chrome.tabs.create({ url: REPO_URL });
      return window.close();
  }
  busyAction = id;
  render();
  if (id === 'pause') await send(MSG.setPaused, { paused: true });
  else if (id === 'resume') await send(MSG.setPaused, { paused: false });
  else if (id === 'reconnect') await send(MSG.reconnect);
  busyAction = null;
  state = await loadState();
  render();
}

async function openSettings() {
  await chrome.runtime.openOptionsPage();
  window.close();
}

// ---------------------------------------------------------------------------------------------

function renderTab(t) {
  const count = state.status.sharedTabs ?? 0;
  const headRow = h('div', { class: 'section-head' },
    h('h2', {}, t('tabs.heading')),
    h('span', { class: 'section-aside' }, t('tabs.count', { n: count })));

  if (!tab) return h('section', { class: 'tab-section' }, headRow);

  const restricted = tabInfo?.restricted ?? isRestrictedUrl(tab.url);
  const shared = !!tabInfo?.shared && !restricted;
  const host = hostOf(tab.url);
  const title = tab.title || host || t('tabs.untitled');

  const button = restricted
    ? h('button', { type: 'button', class: 'btn btn-sm btn-secondary', disabled: true }, t('tabs.share'))
    : shared
      ? h('button', { type: 'button', class: 'btn btn-sm btn-secondary', disabled: tabBusy || !tabInfo, 'aria-label': t('tabs.unshareLabel'), onclick: () => toggleShare(false) }, t('tabs.unshare'))
      : h('button', { type: 'button', class: 'btn btn-sm btn-primary', disabled: tabBusy || !tabInfo, 'aria-label': t('tabs.shareLabel'), onclick: () => toggleShare(true) }, t('tabs.share'));

  const card = h('div', { class: `tab-card${shared ? ' is-shared' : ''}${restricted ? ' is-restricted' : ''}` },
    avatar(host, restricted),
    h('div', { class: 'tab-text' },
      h('div', { class: 'tab-title', title }, title),
      h('div', { class: 'tab-sub' },
        shared
          ? h('span', { class: 'shared-flag' }, icon('check', { size: 12 }), t('tabs.shared'))
          : h('span', { class: 'tab-host', title: tab.url ?? '' }, host || tab.url || ''),
      ),
    ),
    button,
  );

  // The tab-group hint is first-run help: shown until something has been shared.
  let foot = null;
  if (tabFailed) foot = h('p', { class: 'msg tone-danger tab-msg' }, icon('alert', { size: 14 }), h('span', {}, t('tabs.failed')));
  else if (restricted) foot = h('p', { class: 'note tab-msg' }, icon('lock', { size: 14 }), h('span', {}, t('tabs.restricted')));
  else if (!shared && count === 0) foot = h('p', { class: 'note tab-msg' }, icon('info', { size: 14 }), h('span', {}, t('tabs.hint')));

  return h('section', { class: 'tab-section' }, headRow, card, foot);
}

async function toggleShare(share) {
  tabBusy = true;
  tabFailed = false;
  render();
  const r = await send(share ? MSG.shareTab : MSG.unshareTab, { tabId: tab.id });
  tabBusy = false;
  if (!r.ok) {
    if (r.error === 'restricted_url') tabInfo = { shared: false, restricted: true };
    else tabFailed = true;
  }
  await refreshTab();
  render();
}

function avatar(host, restricted) {
  if (restricted || !host) return h('span', { class: 'avatar is-generic' }, icon(restricted ? 'lock' : 'globe', { size: 16 }));
  const name = host.replace(/^www\./, '');
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const el = h('span', { class: 'avatar' }, name[0].toUpperCase());
  el.style.setProperty('--h', String(hash % 360));
  return el;
}

function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host.replace(/^www\./, '') : (u.protocol === 'file:' ? 'file' : u.protocol.replace(':', '') + '://' + u.host);
  } catch {
    return '';
  }
}

function isRestrictedUrl(url) {
  return !/^(https?|file):/.test(url ?? '');
}

// ---------------------------------------------------------------------------------------------

function renderActivity(t, lang) {
  const items = state.activity.slice(0, ACTIVITY_SHOWN);
  const body = items.length
    ? h('ol', { class: 'log' }, items.map((e) => activityRow(e, t, lang)))
    : h('p', { class: 'empty' }, t('activity.empty'));
  return h('section', { class: 'activity' },
    h('div', { class: 'section-head' }, h('h2', {}, t('activity.heading'))),
    body);
}

function activityRow(e, t, lang) {
  const key = `tool.${e.tool}`;
  const label = t(key) === key ? e.tool : t(key);
  const where = e.tab ? (e.tab.host || e.tab.title || '') : '';
  const tip = [e.tab?.title, e.tab?.host, e.ok ? null : `${t('activity.failed')}${e.error ? `: ${e.error}` : ''}`]
    .filter(Boolean).join(' · ');
  return h('li', { class: `log-row${e.ok ? '' : ' is-failed'}`, title: tip || null },
    h('span', { class: 'log-icon' }, icon(e.ok ? 'check' : 'x', { size: 12 })),
    h('span', { class: 'log-tool' }, label),
    !e.ok && h('span', { class: 'log-failed' }, t('activity.failed')),
    h('span', { class: 'log-where' }, where),
    h('time', { class: 'log-time', datetime: new Date(e.t).toISOString() }, formatClock(e.t, lang)),
  );
}

main();

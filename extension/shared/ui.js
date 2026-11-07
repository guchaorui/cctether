// Shared UI helpers for the popup and the settings page: DOM building, icons, the connection-state
// view model and storage access. Pages only render storage and send messages (see contract.js).

import { KEYS, DEFAULT_SETTINGS, DEFAULT_STATUS, MSG, REPO_URL } from './contract.js';
import { displayServer } from './pairing.js';
import { resolveLang, translator, localeOf, formatWait } from './i18n.js';

// ---------------------------------------------------------------------------------------------
// DOM

/** Tiny element builder: h('div', { class: 'x', onclick: fn }, child, 'text', [more]) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

/** Replace el's children, skipping false/null/undefined. */
export function setChildren(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Text with `backtick` spans rendered as <code>. Never parses HTML. */
export function rich(text) {
  const frag = document.createDocumentFragment();
  String(text).split('`').forEach((part, i) => {
    if (!part) return;
    // Short code (commands) never breaks; long code (IDs, URLs) may wrap anywhere.
    frag.append(i % 2 ? h('code', { class: part.length > 28 ? 'is-long' : null }, part) : document.createTextNode(part));
  });
  return frag;
}

/** Fill [data-i18n] / [data-i18n-<attr>] elements under root. */
export function applyStatic(root, t) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.replaceChildren(rich(t(el.dataset.i18n)));
  }
  for (const attr of ['title', 'aria-label', 'placeholder']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Icons (24×24, stroke = currentColor). Original drawings; the tether mark matches icons/icon.svg.

const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
const DOTF = { fill: 'currentColor', stroke: 'none' };

const ICONS = {
  // Two nodes joined by a slack line: the cctether mark.
  mark: [
    ['path', { d: 'M6.6 14.8C9.6 7.3 14.4 16.9 17.4 9.4', 'stroke-width': 2.3 }],
    ['circle', { cx: 6.6, cy: 14.8, r: 2.1, ...DOTF }],
    ['circle', { cx: 17.4, cy: 9.4, r: 2.1, ...DOTF }],
  ],
  // The same line, cut in the middle.
  broken: [
    ['path', { d: 'M6.6 14.8C7.9 11.6 9.3 10.6 10.6 10.9', 'stroke-width': 2.3 }],
    ['path', { d: 'M13.4 13.1C14.7 13.4 16.1 12.4 17.4 9.4', 'stroke-width': 2.3 }],
    ['circle', { cx: 6.6, cy: 14.8, r: 2.1, ...DOTF }],
    ['circle', { cx: 17.4, cy: 9.4, r: 2.1, ...DOTF }],
  ],
  pause: [
    ['rect', { x: 7.5, y: 6.5, width: 3, height: 11, rx: 1, ...DOTF }],
    ['rect', { x: 13.5, y: 6.5, width: 3, height: 11, rx: 1, ...DOTF }],
  ],
  // Larger drawings of the two glyphs that look small next to lock / folder / eye in a list of
  // icons (the mark is flat, the pause bars are narrow), so a column of icons reads as one size.
  markLg: [
    ['path', { d: 'M5.2 16C8.9 6.4 15.1 17.6 18.8 8', 'stroke-width': 2.2 }],
    ['circle', { cx: 5.2, cy: 16, r: 2.4, ...DOTF }],
    ['circle', { cx: 18.8, cy: 8, r: 2.4, ...DOTF }],
  ],
  pauseLg: [
    ['rect', { x: 6.8, y: 5, width: 3.6, height: 14, rx: 1.2, ...DOTF }],
    ['rect', { x: 13.6, y: 5, width: 3.6, height: 14, rx: 1.2, ...DOTF }],
  ],
  play: [['path', { d: 'M8.5 6.8v10.4a.8.8 0 0 0 1.2.7l8.3-5.2a.8.8 0 0 0 0-1.4L9.7 6.1a.8.8 0 0 0-1.2.7z', ...DOTF }]],
  swap: [['path', { d: 'M5 8.5h13M14.5 5l3.5 3.5-3.5 3.5M19 15.5H6M9.5 12 6 15.5 9.5 19' }]],
  shield: [
    ['path', { d: 'M12 3.5 5.5 6v5.2c0 4.2 2.8 7.5 6.5 9.3 3.7-1.8 6.5-5.1 6.5-9.3V6L12 3.5z' }],
    ['path', { d: 'M12 8.5v4' }],
    ['circle', { cx: 12, cy: 15.6, r: 1.1, ...DOTF }],
  ],
  key: [
    ['circle', { cx: 8.5, cy: 12, r: 3.5 }],
    ['path', { d: 'M12 12h8M17 12v3M20 12v2.5' }],
  ],
  update: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 16.5v-9M8.5 11 12 7.5l3.5 3.5' }],
  ],
  clock: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 7.5V12l3 2' }],
  ],
  settings: [
    ['path', { d: 'M4 8h8.5M17.5 8H20M4 16h2.5M11.5 16H20' }],
    ['circle', { cx: 15, cy: 8, r: 2.5 }],
    ['circle', { cx: 9, cy: 16, r: 2.5 }],
  ],
  check: [['path', { d: 'm5.5 12.5 4 4 9-9.5', 'stroke-width': 2.4 }]],
  x: [['path', { d: 'm7 7 10 10M17 7 7 17', 'stroke-width': 2.4 }]],
  info: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 11v5' }],
    ['circle', { cx: 12, cy: 8, r: 1.1, ...DOTF }],
  ],
  alert: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M12 7.5v5' }],
    ['circle', { cx: 12, cy: 15.8, r: 1.1, ...DOTF }],
  ],
  copy: [
    ['rect', { x: 9, y: 9, width: 10.5, height: 10.5, rx: 2 }],
    ['path', { d: 'M15 9V6.5A2 2 0 0 0 13 4.5H6.5a2 2 0 0 0-2 2V13a2 2 0 0 0 2 2H9' }],
  ],
  external: [['path', { d: 'M13.5 5.5h5v5M18.5 5.5l-7 7M16.5 14v3.5a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2H10' }]],
  lock: [
    ['rect', { x: 5.5, y: 10.5, width: 13, height: 9, rx: 2 }],
    ['path', { d: 'M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5' }],
  ],
  chevron: [['path', { d: 'm8 10 4 4 4-4' }]],
  globe: [
    ['circle', { cx: 12, cy: 12, r: 8.5 }],
    ['path', { d: 'M3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5c-2.3-2.4-3.4-5.2-3.4-8.5S9.7 5.9 12 3.5z' }],
  ],
  eye: [
    ['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }],
    ['circle', { cx: 12, cy: 12, r: 2.8 }],
  ],
  eyeOff: [
    ['path', { d: 'M9.9 5.7A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.4 3.2M6.5 7.4C3.9 9.1 2.5 12 2.5 12S6 18.5 12 18.5c1.7 0 3.2-.5 4.5-1.2' }],
    ['path', { d: 'M9.9 10a2.8 2.8 0 0 0 4 4' }],
    ['path', { d: 'm4 4 16 16' }],
  ],
  // A browser window with a row of tabs.
  group: [
    ['path', { d: 'M3.5 9.5v8a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-8' }],
    ['path', { d: 'M3.5 9.5V7a2 2 0 0 1 2-2h4.2a1.5 1.5 0 0 1 1.3.8l1 1.7a1.5 1.5 0 0 0 1.3.8h5.2a2 2 0 0 1 2 2' }],
    ['path', { d: 'M3.5 9.5h17' }],
  ],
};

export function icon(name, { size = 16, cls = '' } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon ${cls}`.trim());
  for (const [tag, attrs] of ICONS[name] ?? []) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries({ ...STROKE, ...attrs })) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

// ---------------------------------------------------------------------------------------------
// Connection state → what to show

const ERROR_ICON = {
  offline: 'broken', unreachable: 'broken', timeout: 'clock', closed: 'broken', rate_limited: 'clock',
  server_auth_failed: 'shield', auth_rejected: 'key', origin_rejected: 'shield', insecure_url: 'shield',
  protocol_error: 'shield', update_extension: 'update', update_server: 'update',
};
const NEEDS_REPAIR = new Set(['server_auth_failed', 'auth_rejected', 'insecure_url']);

/**
 * @typedef {object} StatusView
 * @property {'unpaired'|'connecting'|'connected'|'disconnected'|'replaced'|'paused'} kind
 * @property {'neutral'|'info'|'ok'|'warn'|'danger'} tone
 * @property {string} icon
 * @property {string} title
 * @property {string|null} server     shown under the title
 * @property {string|null} body       may contain `code`
 * @property {string|null} detail
 * @property {number|null} retryAt
 * @property {{ up: boolean, text: string }|null} link   (paused only) is the connection itself up?
 * @property {{ id: string, label: string, kind: 'primary'|'secondary'|'ghost', icon?: string }[]} actions
 */

/** @returns {StatusView} */
export function statusView(rawStatus, rawSettings, pairing, t, extId = '') {
  const s = { ...DEFAULT_STATUS, ...rawStatus };
  const st = { ...DEFAULT_SETTINGS, ...rawSettings };
  const server = s.server ?? (pairing?.url ? displayServer(pairing.url) : null);
  const base = { server, body: null, detail: null, retryAt: null, link: null, actions: [] };

  if (s.conn === 'unpaired' || !pairing) {
    return {
      ...base, kind: 'unpaired', tone: 'neutral', icon: 'mark', server: null,
      title: t('state.unpaired.title'), body: t('state.unpaired.body'),
      actions: [{ id: 'setup', label: t('action.setup'), kind: 'primary' }],
    };
  }

  if (st.paused) {
    const up = s.conn === 'connected';
    return {
      ...base, kind: 'paused', tone: 'warn', icon: 'pause', server: null,
      title: t('state.paused.title'),
      body: t(st.pausedReason === 'debugger_canceled' ? 'state.paused.debugger' : 'state.paused.body'),
      link: server ? { up, text: t(up ? 'state.paused.linkUp' : 'state.paused.linkDown', { server }) } : null,
      actions: [{ id: 'resume', label: t('action.resume'), kind: 'primary', icon: 'play' }],
    };
  }

  const pause = { id: 'pause', label: t('action.pause'), kind: 'ghost', icon: 'pause' };

  switch (s.conn) {
    case 'connected':
      return { ...base, kind: 'connected', tone: 'ok', icon: 'mark', title: t('state.connected.title'), actions: [pause] };
    case 'connecting':
      return { ...base, kind: 'connecting', tone: 'info', icon: 'mark', title: t('state.connecting.title'), actions: [pause] };
    case 'replaced':
      return {
        ...base, kind: 'replaced', tone: 'warn', icon: 'swap',
        title: t('state.replaced.title'), body: t('state.replaced.body'),
        actions: [{ id: 'reconnect', label: t('action.reconnectHere'), kind: 'primary' }],
      };
    default: {
      const code = s.error?.code && t(`err.${s.error.code}.title`) !== `err.${s.error.code}.title` ? s.error.code : 'unknown';
      const actions = [];
      if (NEEDS_REPAIR.has(code)) actions.push({ id: 'pairAgain', label: t('action.pairAgain'), kind: 'primary' });
      if (code === 'update_extension') actions.push({ id: 'getUpdate', label: t('action.getUpdate'), kind: 'primary', icon: 'external' });
      actions.push({ id: 'reconnect', label: t('action.reconnect'), kind: actions.length ? 'secondary' : 'primary' });
      return {
        ...base, kind: 'disconnected', tone: 'danger', icon: ERROR_ICON[code] ?? 'broken',
        title: t(`err.${code}.title`),
        body: t(`err.${code}.body`, { server: server ?? '', id: extId }),
        detail: s.error?.detail ? t('err.detail', { detail: s.error.detail }) : null,
        retryAt: s.retryAt ?? null,
        actions,
      };
    }
  }
}

/** Countdown text for retryAt, or null. */
export function retryText(retryAt, t, now = Date.now()) {
  if (!retryAt) return null;
  const ms = retryAt - now;
  return ms > 500 ? t('retry.in', { time: formatWait(ms, t) }) : t('retry.now');
}

/** Big round state icon used at the top of the popup and the connection card. */
export function stateBadge(view) {
  const spin = view.kind === 'connecting';
  return h('span', { class: `state-badge tone-${view.tone}${spin ? ' is-spinning' : ''}${view.kind === 'unpaired' ? ' is-soft' : ''}` },
    icon(view.icon, { size: 24 }));
}

// ---------------------------------------------------------------------------------------------
// Storage and messages

/** Read everything the UI renders. */
export async function loadState() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get([KEYS.settings, KEYS.pairing]),
    chrome.storage.session.get([KEYS.status, KEYS.activity]),
  ]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...local[KEYS.settings] },
    pairing: local[KEYS.pairing] ?? null,
    status: { ...DEFAULT_STATUS, ...session[KEYS.status] },
    activity: Array.isArray(session[KEYS.activity]) ? session[KEYS.activity] : [],
  };
}

/** Call fn(changedKeys) whenever any UI-relevant storage key changes. */
export function onStateChange(fn) {
  const watched = new Set(Object.values(KEYS));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' && area !== 'session') return;
    const keys = Object.keys(changes).filter((k) => watched.has(k));
    if (keys.length) fn(new Set(keys));
  });
}

/** Send a command to the service worker. Always resolves to { ok, ... }. */
export async function send(type, params = {}) {
  try {
    const reply = await chrome.runtime.sendMessage({ type, ...params });
    return reply && typeof reply === 'object' ? reply : { ok: false, error: 'no_reply' };
  } catch (e) {
    return { ok: false, error: 'no_reply', detail: String(e?.message ?? e) };
  }
}

/** Save the language choice. The service worker owns the rest of settings; merge, don't replace. */
export async function setLanguage(lang) {
  const { [KEYS.settings]: cur } = await chrome.storage.local.get(KEYS.settings);
  await chrome.storage.local.set({ [KEYS.settings]: { ...DEFAULT_SETTINGS, ...cur, lang } });
}

/** Language helpers bound to current settings. */
export function languageFor(settings) {
  const lang = resolveLang(settings?.lang);
  return { lang, t: translator(lang), locale: localeOf(lang) };
}

export function setDocumentLanguage(lang, t, titleKey) {
  document.documentElement.lang = localeOf(lang);
  if (titleKey) document.title = t(titleKey);
}

export { MSG, REPO_URL };

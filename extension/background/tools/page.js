// Tools that read or drive a page as a whole: navigate, read_page, find, screenshot,
// resize_viewport, set_color_scheme, evaluate, wait_for. Each gets ctx = { tab, s } where s is the
// tab's debugger session (debugger.js).

import { ToolError } from './errors.js';
import { untrusted, q, page, sleep, normalizeUrl, imageSize, withTimeout } from './util.js';
import { exceptionToText } from './format.js';
import { isRestrictedUrl, restrictedMessage, isShared } from '../tabs.js';
import {
  dialogError, CdpError, isContextGone, detachedError, session,
  emulationsReady, saveEmulations, clearLostEmulation,
} from '../debugger.js';
import { SERIALIZE_FN } from '../page-scripts.js';
import { tabSummary, waitTabComplete } from './browser.js';

const text = (t) => ({ type: 'text', text: t });

// ---- navigate ----------------------------------------------------------------------------------

function loadedText(t, st, ok, timeoutMs) {
  const status = st?.status ? ` (HTTP ${st.status})` : st?.bfcache ? ' (restored from the back/forward cache)' : '';
  if (!ok) {
    return `Still loading after ${timeoutMs} ms: ${t.url} ${q(t.title, 100)}. The page may be usable already; use wait_for or read_page.`;
  }
  return `Loaded ${t.url}${status}: ${q(t.title || '(no title)', 100)}`;
}

/** navigate when the current page is restricted (no debugger): plain chrome.tabs calls. */
async function navigateWithoutDebugger(tab, args, timeoutMs) {
  const started = Date.now();
  if (args.url != null) {
    const url = normalizeUrl(args.url);
    if (await isRestrictedUrl(url)) throw new ToolError('restricted_url', restrictedMessage(url));
    await chrome.tabs.update(tab.id, { url });
  } else if (args.action === 'back') {
    await chrome.tabs.goBack(tab.id);
  } else if (args.action === 'forward') {
    await chrome.tabs.goForward(tab.id);
  } else {
    await chrome.tabs.reload(tab.id);
  }
  await sleep(100);
  const ok = await waitTabComplete(tab.id, timeoutMs);
  const loadedAt = Date.now();
  // From the moment it loaded: the tab starting to load again means another page (or perhaps a
  // hash change; then "navigated again" is said wrongly, which is the harmless direction).
  let reloading = false;
  const onUpdated = (id, info) => { if (id === tab.id && info.status === 'loading') reloading = true; };
  if (args.wait_for) chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    return await afterRestrictedLoad(tab, args, timeoutMs, started, ok, loadedAt, () => reloading);
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
}

async function afterRestrictedLoad(tab, args, timeoutMs, started, ok, loadedAt, reloading) {
  const t = await tabSummary(tab.id);
  let msg = loadedText(t, null, ok, timeoutMs);
  if (args.wait_for) {
    // The new page may be one cctether can work on: attach to wait for the condition there.
    let now = null;
    try { now = await chrome.tabs.get(tab.id); } catch { /* closed */ }
    if (await isRestrictedUrl(t.url)) {
      msg += ` ${t.url.split(/[?#]/)[0]} is a restricted page, so cctether can't wait for anything on it.`;
    } else if (!now || !(await isShared(now))) {
      // The user may have taken the tab out of the group while it loaded: don't attach then.
      msg += ' The tab is no longer shared with cctether (closed, or taken out of the cctether group), so it did not wait for anything.';
    } else {
      const s = await session(tab.id);
      s.busy++;
      try {
        msg += ` ${await afterLoad(s, args.wait_for, started + timeoutMs, reloading, loadedAt)}`;
      } finally {
        s.busy--;
        s.touch();
      }
    }
  }
  return { content: [text(msg)], tab: t };
}

export async function navigate(ctx, args) {
  const { tab, s } = ctx;
  if ((args.url == null) === (args.action == null)) {
    throw new ToolError('bad_args', 'Pass either `url`, or `action` ("back", "forward" or "reload").');
  }
  if (args.wait_for && args.wait_for.text == null && args.wait_for.selector == null) {
    throw new ToolError('bad_args', '`wait_for` needs `text`, `selector`, or both.');
  }
  const timeoutMs = args.timeout_ms ?? 30000;
  if (!s) return navigateWithoutDebugger(tab, args, timeoutMs);
  const started = Date.now();
  const left = () => Math.max(0, timeoutMs - (Date.now() - started));
  const w = s.navWatch();
  try {
    let r;
    if (args.url != null) {
      const url = normalizeUrl(args.url);
      if (await isRestrictedUrl(url)) throw new ToolError('restricted_url', restrictedMessage(url));
      r = await s.raceDialog(s.send('Page.navigate', { url, transitionType: 'typed' }, { timeoutMs }));
      if (r.value) {
        const { errorText, loaderId } = r.value;
        if (errorText && errorText !== 'net::ERR_ABORTED') {
          throw new ToolError('not_found', `Could not load ${url}: ${errorText}. Check the address, and whether the site is reachable from the user's browser.`);
        }
        if (errorText === 'net::ERR_ABORTED') {
          const t = await tabSummary(tab.id);
          return { content: [text(`The navigation to ${url} was aborted (net::ERR_ABORTED): the server may have sent a download or an empty response. The tab shows ${t.url}.`)], tab: t };
        }
        if (!loaderId) w.st.sameDoc = true; // same-document navigation (only the #hash changed)
      }
    } else if (args.action === 'reload') {
      r = await s.raceDialog(s.send('Page.reload', { ignoreCache: false }, { timeoutMs }));
    } else {
      const h = await s.guardDialog(s.send('Page.getNavigationHistory'));
      const idx = h.currentIndex + (args.action === 'back' ? -1 : 1);
      if (idx < 0 || idx >= h.entries.length) {
        throw new ToolError('not_found', `There is no page to go ${args.action} to in this tab's history.`);
      }
      r = await s.raceDialog(s.send('Page.navigateToHistoryEntry', { entryId: h.entries[idx].id }, { timeoutMs }));
    }
    if (r.dialog) {
      const t = await tabSummary(tab.id);
      return { content: [text(`${dialogError(tab.id, r.dialog).message} The navigation waits for it.`)], tab: t };
    }
    const ok = await w.until((st) => st.loaded || st.sameDoc || st.stopped, left());
    // Taken right away. A navigation that finished (or stayed in the document) commits no more;
    // one still loading after the timeout commits once more. Any other commit is another page.
    const expected = ok ? w.st.commits : Math.max(1, w.st.commits);
    s.resetWorld();
    const t = await tabSummary(tab.id);
    let msg = loadedText(t, w.st, ok, timeoutMs);
    if (args.wait_for) msg += ` ${await afterLoad(s, args.wait_for, started + timeoutMs, () => w.st.commits > expected)}`;
    return { content: [text(msg)], tab: t };
  } finally {
    w.stop();
  }
}

// ---- read_page ---------------------------------------------------------------------------------

export async function readPage({ s }, args) {
  const mode = args.mode ?? 'text';
  const offset = args.offset ?? 0;
  const max = args.max_chars ?? 20000;
  const sel = args.selector;
  let header;
  let body;
  let after = '';
  if (mode === 'text') {
    const r = await s.lib('readText', [{ selector: sel }]);
    header = `Title: ${r.title}\nURL: ${r.url}${sel ? `\nSelector: ${sel}` : ''}`;
    body = r.text || '(no visible text)';
  } else if (mode === 'interactive') {
    const r = await s.lib('interactive', [{ selector: sel }]);
    header = `Title: ${r.title}\nURL: ${r.url}\n${r.total} interactive elements${r.total > r.shown ? ` (first ${r.shown} listed)` : ''}`
      + `${sel ? ` inside ${sel}` : ''}. Viewport ${r.vw}×${r.vh}; ↑ ↓ ← → = outside the viewport in that direction.`
      + `${r.grouped ? ' Grouped: open dialogs first, then the main content, then the rest of the page, navigation last.' : ''}`;
    body = r.lines.join('\n') || '(no interactive elements found)';
    after = 'Pass a [number] as `ref` to click, type, hover, select_option, scroll or screenshot. Numbers stay valid until the page navigates or reloads.';
  } else {
    const r = await s.lib('html', [{ selector: sel }]);
    const removed = [r.scripts && `${r.scripts} inline <script> bodies`, r.styles && `${r.styles} <style> bodies`, r.attrs && `${r.attrs} long attribute values`]
      .filter(Boolean);
    header = `Title: ${r.title}\nURL: ${r.url}\nHTML of ${sel || 'body'} (${r.html.length} characters)${removed.length ? `; shortened: ${removed.join(', ')}` : ''}.`;
    body = r.html;
  }
  const p = page(body, offset, max);
  const out = untrusted(`${header}\n\n${p.slice}`) + [p.note, after].filter(Boolean).map((x) => `\n${x}`).join('');
  return { content: [text(out)] };
}

// ---- find --------------------------------------------------------------------------------------

export async function find({ s }, args) {
  if (args.selector == null && args.text == null) throw new ToolError('bad_args', 'Pass `selector`, `text`, or both.');
  const r = await s.lib('find', [{ selector: args.selector, text: args.text, limit: args.limit ?? 20 }]);
  const what = args.text != null
    ? `text ${q(args.text, 200)}${args.selector != null ? ` among elements matching ${q(args.selector, 200)}` : ''}`
    : q(args.selector, 200);
  if (!r.count) {
    return { content: [text(args.text != null ? `No visible element has ${what}.` : `No elements match ${what}.`)] };
  }
  const lines = r.items.map((it) => {
    const [x, y, w, h] = it.rect;
    return `[${it.ref}] ${it.tag}${it.attrs.length ? ` ${it.attrs.join(' ')}` : ''}${it.text ? ` ${JSON.stringify(it.text)}` : ''} at (${x}, ${y}) ${w}×${h}, ${it.vis}${it.contains ? ' (contains it)' : ''}`;
  });
  const exact = r.exact != null ? `, ${r.exact} with exactly that text or name, listed first` : '';
  const head = `${r.count} element${r.count === 1 ? '' : 's'} match ${what}${exact}${r.count > r.items.length ? ` (showing the first ${r.items.length})` : ''}.`;
  return {
    content: [text(`${head}\n${untrusted(lines.join('\n'))}\nPositions are viewport CSS pixels (x, y, width×height). Pass a [number] as \`ref\` to other tools.`)],
  };
}

// ---- screenshot --------------------------------------------------------------------------------

// Claude's image limits (Claude docs, "vision-coordinates", standard tier): the long edge at most
// 1568 px, and at most 1568 visual tokens of 28×28 px. An image over either is scaled down again
// on Claude's side, and then points measured on it no longer match what we said (a 1920×1080
// viewport as 1568×882 becomes 1456×819 there). Newer models allow more, but which model is on
// the other side is unknown here.
const MAX_EDGE = 1568;
const MAX_TOKENS = 1568;
const PATCH = 28;
const FULL_PAGE_MAX_HEIGHT = 16000;

const tokensOf = (w, h) => Math.ceil(w / PATCH) * Math.ceil(h / PATCH);

/** The largest scale ≤ 1 at which a w×h CSS px area fits both image limits. */
export function fitScale(w, h) {
  const fits = (s) => {
    const a = Math.max(1, Math.round(w * s));
    const b = Math.max(1, Math.round(h * s));
    return Math.max(a, b) <= MAX_EDGE && tokensOf(a, b) <= MAX_TOKENS;
  };
  let hi = Math.min(1, MAX_EDGE / Math.max(w, h));
  if (fits(hi)) return hi;
  let lo = 0;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

// Screenshots are numbered, so that click/hover/scroll can take a point on the image and convert
// it themselves (SPEC §5.2). Numbers are kept per tab session (the last SHOTS_KEPT); they start at
// a random number so that a number from before a service-worker restart is unlikely to name a
// different screenshot now.
const SHOTS_KEPT = 20;
let nextShot = 1 + Math.floor(Math.random() * 9000);
/** Screenshot number -> tab id, for a clear message when a number from another tab is used. */
const shotTabs = new Map();

function remember(s, tabId, shot) {
  const id = nextShot++;
  s.shots.set(id, shot);
  while (s.shots.size > SHOTS_KEPT) s.shots.delete(s.shots.keys().next().value);
  shotTabs.set(id, tabId);
  while (shotTabs.size > 500) shotTabs.delete(shotTabs.keys().next().value);
  return id;
}

/**
 * The viewport point for point (x, y) of screenshot `id`, after checking that the page still is
 * as the screenshot showed it. Points of full-page and element screenshots are scrolled into view
 * first if needed. Returns { x, y, note }.
 */
export async function shotPoint(s, tabId, id, x, y) {
  const shot = s.shots.get(id);
  if (!shot) {
    const other = shotTabs.get(id);
    throw new ToolError('bad_args', other != null && other !== tabId
      ? `Screenshot ${id} is of tab ${other}, not tab ${tabId}. Pass tab: ${other}, or take a screenshot of this tab.`
      : `Screenshot ${id} is not known for tab ${tabId}: cctether keeps the last ${SHOTS_KEPT} per tab, until it lets go of the tab (5 min without tool calls, or a pause). Take a new screenshot.`);
  }
  if (shot.kind === 'stitched') {
    throw new ToolError('bad_args', `Screenshot ${id} was stitched together while scrolling an element, so its points can't be clicked. Use ref or text, or take a viewport screenshot.`);
  }
  if (x < 0 || y < 0 || x > shot.w || y > shot.h) {
    throw new ToolError('bad_args', `(${x}, ${y}) is outside screenshot ${id}, which is ${shot.w}×${shot.h} px.`);
  }
  const m = await s.lib('metrics');
  const changed = [];
  if (m.doc !== shot.doc) changed.push('the page navigated or reloaded');
  if (Math.abs(m.vw - shot.vw) > 1 || Math.abs(m.vh - shot.vh) > 1) changed.push(`the viewport changed from ${shot.vw}×${shot.vh} to ${m.vw}×${m.vh} CSS px`);
  // A full-page screenshot is in page coordinates; the others show the viewport as it was.
  if (shot.kind !== 'page' && (Math.abs(m.scrollX - shot.scrollX) > 1 || Math.abs(m.scrollY - shot.scrollY) > 1)) {
    changed.push(`the page scrolled (from x=${Math.round(shot.scrollX)}, y=${Math.round(shot.scrollY)} to x=${Math.round(m.scrollX)}, y=${Math.round(m.scrollY)})`);
  }
  if (changed.length) {
    throw new ToolError('stale_screenshot', `Not done: since screenshot ${id}, ${changed.join(' and ')}, so that point may show something else now. Take a new screenshot and use its number.`);
  }
  // Page coordinates of the point, then viewport coordinates now.
  const px = shot.x0 + x * shot.rx;
  const py = shot.y0 + y * shot.ry;
  let sx = m.scrollX;
  let sy = m.scrollY;
  const inside = () => px - sx >= 0 && py - sy >= 0 && px - sx < m.vw && py - sy < m.vh;
  let note = '';
  if (!inside() && shot.kind !== 'page') {
    throw new ToolError('bad_args', `That point of screenshot ${id} is outside the viewport now. Scroll it into view and take a new screenshot, or use a full-page screenshot.`);
  }
  if (!inside()) {
    const r = await s.lib('scrollPageTo', [{ x: px, y: py }]);
    if (r.doc !== shot.doc) throw new ToolError('stale_screenshot', `Not done: the page navigated while scrolling to that point of screenshot ${id}. Take a new screenshot.`);
    sx = r.scrollX;
    sy = r.scrollY;
    if (!inside()) throw new ToolError('bad_args', `Could not scroll page point (${Math.round(px)}, ${Math.round(py)}) of screenshot ${id} into the viewport.`);
    note = ` (scrolled the page to y=${Math.round(sy)} first)`;
  }
  return { x: px - sx, y: py - sy, note };
}

/** Background tab, or its window is minimized (the page itself may still claim to be visible). */
async function isHiddenTab(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (!t.active) return true;
    const w = await chrome.windows.get(t.windowId);
    return w.state === 'minimized';
  } catch {
    return true;
  }
}

async function capture(s, tabId, params, hidden) {
  // A hidden (background) tab only paints a fresh frame when something asks for frames; without
  // this a capture after the page changed can stall for seconds. A tiny screencast keeps it
  // painting while we capture, without bringing the tab to the front.
  s.capturing++; // tells a resize_viewport reset not to stop the screencast under us
  if (hidden) {
    const frame = s.waitFor((m) => m === 'Page.screencastFrame', 1000);
    await s.send('Page.startScreencast', SCREENCAST, { timeoutMs: 3000 }).catch(() => {});
    await frame;
  }
  try {
    return await s.guardDialog(s.send('Page.captureScreenshot', params, { timeoutMs: 8000 }));
  } catch (e) {
    if (!(e instanceof ToolError) || e.code !== 'timeout') throw e;
    // Still nothing: bring the tab to the front and try once more.
    await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    await sleep(300);
    return s.guardDialog(s.send('Page.captureScreenshot', params, { timeoutMs: 15000 }));
  } finally {
    s.capturing--;
    if (hidden) s.send('Page.stopScreencast', {}, { timeoutMs: 3000 }).catch(() => {});
  }
}

const SCREENCAST = { format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16, everyNthFrame: 1 };

/** Three decimals: at 2000 → 1568 px, 1.28 instead of 1.2755 would be 7 px off at the far edge. */
const round3 = (n) => Math.round(n * 1000) / 1000;

export async function screenshot({ tab, s }, args) {
  if (args.full_page && (args.ref != null || args.selector != null)) return scrollerShot({ tab, s }, args);
  const format = args.format ?? 'jpeg';
  const quality = args.quality ?? 75;
  let clip;
  let mode;
  let beyond = false;
  let cut = '';
  let m;
  if (args.ref != null || args.selector != null) {
    const r = await s.lib('elementRect', [{ ref: args.ref, selector: args.selector }]);
    m = await s.lib('metrics');
    const x = Math.max(0, r.x + m.scrollX);
    const y = Math.max(0, r.y + m.scrollY);
    clip = { x, y, width: Math.min(r.width, m.docW - x), height: Math.min(r.height, m.docH - y) };
    beyond = r.x < 0 || r.y < 0 || r.x + r.width > r.vw || r.y + r.height > r.vh;
    if (clip.height > FULL_PAGE_MAX_HEIGHT) { clip.height = FULL_PAGE_MAX_HEIGHT; cut = ` Cut at ${FULL_PAGE_MAX_HEIGHT} CSS px tall.`; }
    mode = `element ${r.desc}`;
  } else if (args.full_page) {
    m = await s.lib('metrics');
    const lm = await s.guardDialog(s.send('Page.getLayoutMetrics'));
    const W = Math.ceil(lm.cssContentSize?.width ?? m.docW);
    const H = Math.ceil(lm.cssContentSize?.height ?? m.docH);
    clip = { x: 0, y: 0, width: W, height: Math.min(H, FULL_PAGE_MAX_HEIGHT) };
    if (H > FULL_PAGE_MAX_HEIGHT) cut = ` The page is ${H} CSS px tall; the image stops at ${FULL_PAGE_MAX_HEIGHT}.`;
    beyond = true;
    mode = 'full page';
  } else {
    m = await s.lib('metrics');
    clip = { x: m.scrollX, y: m.scrollY, width: m.vw, height: m.vh };
    mode = 'viewport';
  }
  if (!(clip.width >= 1 && clip.height >= 1)) {
    throw new ToolError('no_element', 'There is nothing to capture (zero-size area).');
  }
  const fit = fitScale(clip.width, clip.height);
  const params = {
    format,
    clip: { ...clip, scale: fit / (m.dpr || 1) },
    captureBeyondViewport: beyond,
    fromSurface: true,
  };
  if (format === 'jpeg') params.quality = quality;
  const hidden = await isHiddenTab(tab.id);
  const want = { width: Math.round(clip.width * fit), height: Math.round(clip.height * fit) };
  let r = await capture(s, tab.id, params, hidden);
  let size = imageSize(r.data) ?? want;
  if (Math.abs(size.width - want.width) > 2) {
    // Chrome ignores a devicePixelRatio emulated by another debugging client (e.g. DevTools'
    // device mode) when scaling captures: correct the scale and capture again.
    params.clip.scale *= want.width / size.width;
    r = await capture(s, tab.id, params, hidden);
    size = imageSize(r.data) ?? want;
  }
  // Each axis on its own: the image size is rounded per axis.
  const id = remember(s, tab.id, {
    kind: mode === 'viewport' ? 'viewport' : mode === 'full page' ? 'page' : 'element', doc: m.doc, vw: m.vw, vh: m.vh, scrollX: m.scrollX, scrollY: m.scrollY,
    x0: clip.x, y0: clip.y, rx: clip.width / size.width, ry: clip.height / size.height, w: size.width, h: size.height,
  });
  const ratio = round3(clip.width / size.width);
  const scaled = Math.abs(ratio - 1) >= 0.01;
  let desc = `${size.width}×${size.height} ${format.toUpperCase()}, ${mode}, `;
  desc += scaled ? `scaled down to fit Claude's image size limits: 1 image px = ${ratio} CSS px.` : '1 px = 1 CSS px.';
  desc += ` This is screenshot ${id}: to click, hover or scroll at a point you see in it, pass the point's image x, y with screenshot: ${id}`
    + `${mode === 'full page' ? ' (the page is scrolled to it first if needed)' : ''}; cctether converts them.`;
  if (mode === 'full page') desc += ` The viewport is currently scrolled to y=${Math.round(m.scrollY)}.`;
  desc += cut;
  if (mode === 'full page' && clip.height <= m.vh + 1) {
    // An app shell: the page doesn't scroll, a pane inside it does. Say how to get all of it.
    const pane = await s.lib('mainScroller').catch(() => null);
    if (pane) {
      desc += ` The page itself does not scroll: its content scrolls inside [${pane.ref}] ${pane.desc} (${pane.height} CSS px tall). To capture all of that, call screenshot with ref: ${pane.ref} and full_page: true.`;
    }
  }
  // The size measured for this capture, not the requested one: a resize running at the same
  // time may or may not have happened yet.
  if (s.viewport) desc += ` Viewport: ${m.vw}×${m.vh} CSS px (resize_viewport override).`;
  if (s.colorScheme) desc += ` Color scheme: ${s.colorScheme} (set_color_scheme override).`;
  return {
    content: [
      { type: 'image', data: r.data, mimeType: `image/${format}` },
      text(desc),
    ],
  };
}

// ---- screenshot of an element's whole scrollable content ---------------------------------------
//
// Scroll the element step by step, capture the part of its box that shows new content each time,
// and stitch the parts on a canvas. Sticky or fixed bars at the box's top and bottom edges are
// measured at every step, so they appear once (at the top / bottom) rather than in every part.
// Parts are placed by the scroll position actually reached; rows no step showed are reported.

const STITCH_MAX_STEPS = 80;

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function blobToB64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function scrollerShot({ tab, s }, args) {
  const format = args.format ?? 'jpeg';
  const quality = args.quality ?? 75;
  const info = await s.lib('scrollerInfo', [{ ref: args.ref, selector: args.selector }]);
  const dpr = (await s.lib('metrics')).dpr || 1;
  // Keep the tab painting for the whole run (one screencast, frames acknowledged), so that each
  // capture shows the new scroll position, also in a background tab.
  s.capturing++;
  const off = s.on((method, p) => {
    if (method === 'Page.screencastFrame') s.send('Page.screencastFrameAck', { sessionId: p.sessionId }, { timeoutMs: 2000 }).catch(() => {});
  });
  const painted = () => s.waitFor((method) => method === 'Page.screencastFrame', 500);
  let first = painted();
  await s.send('Page.startScreencast', SCREENCAST, { timeoutMs: 3000 }).catch(() => {});
  let st = null;
  try {
    const step = async (top) => {
      const next = painted();
      const r = await s.lib('scrollerStep', [{ ref: info.ref, top, doc: info.doc }]);
      if (r.doc !== info.doc) throw new ToolError('navigated', 'The page navigated while cctether was scrolling through the element to capture it.');
      await (first ?? next);
      first = null;
      return r;
    };
    st = await step(0);
    const total = Math.min(st.height, FULL_PAGE_MAX_HEIGHT);
    const W = st.box.width;
    const fit = fitScale(W, total);
    const outW = Math.max(1, Math.round(W * fit));
    const outH = Math.max(1, Math.round(total * fit));
    const canvas = new OffscreenCanvas(outW, outH);
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, outW, outH);
    let covered = 0;
    let steps = 0;
    let retried = false;
    const gaps = [];
    for (;;) {
      const t = st.top;
      const box = st.box;
      const atEnd = t + box.height >= st.height - 1;
      const bandTop = steps === 0 ? t : t + st.bars.top;
      const bandBottom = atEnd ? t + box.height : t + box.height - st.bars.bottom;
      if (steps > 0 && bandTop > covered + 1 && !retried) {
        // A bar at the top that the last step didn't have (a header that sticks only after some
        // scrolling): step back so the rows under it are shown once more.
        retried = true;
        st = await step(Math.max(0, covered - st.bars.top));
        continue;
      }
      if (bandTop > covered + 1) gaps.push([Math.round(covered), Math.round(bandTop)]);
      const from = Math.max(bandTop, covered);
      const to = Math.min(bandBottom, total);
      if (to > from) {
        const clip = { x: st.scrollX + box.left, y: st.scrollY + box.top + (from - t), width: box.width, height: to - from, scale: fit / dpr };
        const part = await capture(s, tab.id, { format: 'png', clip, captureBeyondViewport: false, fromSurface: true }, false);
        const bmp = await createImageBitmap(b64ToBlob(part.data, 'image/png'));
        const y0 = Math.round(from * fit);
        const y1 = Math.max(y0 + 1, Math.round(to * fit));
        g.drawImage(bmp, 0, y0, outW, y1 - y0);
        bmp.close();
        covered = to;
      }
      steps++;
      retried = false;
      if (atEnd || covered >= total) break;
      const next = covered - st.bars.top;
      if (steps >= STITCH_MAX_STEPS || next <= t + 0.5) {
        gaps.push([Math.round(covered), Math.round(total)]);
        break;
      }
      st = await step(next);
    }
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const data = await blobToB64(await canvas.convertToBlob(format === 'png' ? { type: mime } : { type: mime, quality: quality / 100 }));
    const id = remember(s, tab.id, { kind: 'stitched' });
    const ratio = round3(W / outW);
    let desc = `${outW}×${outH} ${format.toUpperCase()}, the whole scrollable content of ${info.desc} (${st.height} CSS px tall), stitched from ${steps} capture${steps === 1 ? '' : 's'} while scrolling it`
      + `${info.moved ? ' (the page was scrolled to show its top first)' : ''}${st.box.cut ? ' (only the part of its width and height inside the viewport)' : ''}`;
    desc += Math.abs(ratio - 1) >= 0.01 ? `; scaled down to fit Claude's image size limits: 1 image px = ${ratio} CSS px.` : '; 1 px = 1 CSS px.';
    if (st.height > FULL_PAGE_MAX_HEIGHT) desc += ` The image stops at ${FULL_PAGE_MAX_HEIGHT} CSS px.`;
    if (gaps.length) desc += ` Rows not captured (left white): ${gaps.map(([a, b]) => `${a}–${b}`).join(', ')} CSS px from the top.`;
    desc += ' Scrolling it may have loaded or changed content (lazy loading, virtual lists show only some rows).'
      + ` This is screenshot ${id}; its points can't be used with click. Use ref or text, or a viewport screenshot.`;
    return { content: [{ type: 'image', data, mimeType: mime }, text(desc)] };
  } finally {
    off();
    s.capturing--;
    s.send('Page.stopScreencast', {}, { timeoutMs: 3000 }).catch(() => {});
    // Back to where it was, unless the page or someone else moved it meanwhile.
    if (st && !s.closed) await s.lib('scrollerRestore', [{ ref: info.ref, top: info.top, expect: st.top, doc: info.doc }]).catch(() => false);
  }
}

// ---- emulation (resize_viewport, set_color_scheme) ----------------------------------------------
//
// Both emulate something for this one tab through the debugger, without touching the browser's
// window or settings. Chrome drops emulations when the debugger detaches; debugger.js records
// that and tools/index.js tells Claude on the next call.

const POLL_MS = 75;

/**
 * Run the emulation tools on one tab one after another (one queue for both): two width-only
 * calls must not race, and every call sees the state the previous one left.
 */
function queued(s, fn) {
  const run = s.emulationQueue.then(async () => {
    // The records of an earlier worker instance must be in place before a call changes them.
    await emulationsReady();
    return fn();
  });
  s.emulationQueue = run.catch(() => {}); // a failed call must not block the next one
  return run;
}

/**
 * Read the page's metrics until done(metrics) or ms pass. Errors are ignored (the page may be
 * navigating). Returns the last reading, or null if there was none.
 */
async function pollMetrics(s, done, ms) {
  const deadline = Date.now() + ms;
  let last = null;
  for (;;) {
    const left = deadline - Date.now();
    try {
      last = await withTimeout(s.lib('metrics'), Math.max(100, left), () => new Error('timeout'));
      if (done(last)) return last;
    } catch { /* navigating or busy: try again */ }
    if (s.closed || Date.now() + POLL_MS >= deadline) return last;
    await sleep(POLL_MS);
  }
}

// ---- resize_viewport ---------------------------------------------------------------------------
//
// Emulates a viewport size (Emulation.setDeviceMetricsOverride). A desktop viewport, not a phone
// (mobile: false; the device pixel ratio stays). The tab is not brought to the front.

const VIEWPORT_MIN = 200;
const VIEWPORT_MAX = 3840;
const SET_SETTLE_MS = 1500;
const RESET_SETTLE_MS = 1000;

async function pageZoom(tabId) {
  try {
    const z = await chrome.tabs.getZoom(tabId);
    return z > 0 ? z : 1;
  } catch {
    return 1;
  }
}

export async function resizeViewport(ctx, args) {
  const reset = args.reset === true;
  const sized = args.width != null || args.height != null;
  if (reset && sized) throw new ToolError('bad_args', 'Pass either reset: true, or width/height, not both.');
  if (!reset && !sized) throw new ToolError('bad_args', 'Pass width and/or height, or reset: true.');
  return queued(ctx.s, () => (reset ? resetViewport(ctx) : setViewport(ctx, args)));
}

async function setViewport({ tab, s }, args) {
  const before = await s.lib('metrics');
  // An omitted dimension keeps its size at the time of the call (and from then on).
  const pick = (dim, measured) => {
    if (args[dim] != null) return args[dim];
    const v = s.viewport ? s.viewport[dim] : measured;
    if (!(v >= VIEWPORT_MIN && v <= VIEWPORT_MAX)) {
      throw new ToolError('bad_args', `The current ${dim} is ${v} CSS px, outside ${VIEWPORT_MIN}–${VIEWPORT_MAX}: pass both width and height.`);
    }
    return v;
  };
  const width = pick('width', before.vw);
  const height = pick('height', before.vh);
  // Chrome takes the size before page zoom. Both dimensions are always sent: 0 ("keep") is
  // unreliable in background tabs.
  const zoom = await pageZoom(tab.id);
  // Record the override before sending it: if the session ends while the command is on its way,
  // dropSession() must see it (Chrome may have applied it, and drops it with the session).
  if (s.closed) throw detachedError(tab.id); // ended before anything was sent: nothing to record
  const prev = s.viewport;
  s.viewport = { width, height };
  saveEmulations();
  try {
    await s.send('Emulation.setDeviceMetricsOverride', {
      width: Math.round(width * zoom), height: Math.round(height * zoom), deviceScaleFactor: 0, mobile: false,
    });
  } catch (e) {
    // Chrome refused it, so nothing changed: put the previous state back. (After a timeout it may
    // have been applied; and once the session is closed, what dropSession() recorded stands.)
    if (e instanceof CdpError && !s.closed) {
      s.viewport = prev;
      saveEmulations();
    }
    throw e;
  }
  // The session ended while the command was on its way, taking the override with it: keep the
  // lost record dropSession() made, so the next call reports it.
  if (s.closed) throw detachedError(tab.id);
  clearLostEmulation(tab.id, 'viewport');
  const near = (m) => Math.abs(m.vw - width) <= 1 && Math.abs(m.vh - height) <= 1;
  const now = await pollMetrics(s, near, SET_SETTLE_MS);
  // Ended during the wait: say so rather than "remains active"; dropSession() recorded it.
  if (s.closed) throw detachedError(tab.id);
  let msg;
  if (!now) {
    msg = `Viewport override set to ${width}×${height} CSS px for tab ${tab.id}, but the page did not report its size in time (it may be loading or busy). Check with screenshot.`;
  } else if (!near(now)) {
    msg = `Requested ${width}×${height}; the page reports ${now.vw}×${now.vh} CSS px. The override remains active (reset: true clears it).`;
  } else {
    msg = `Tab ${tab.id} viewport is now ${now.vw}×${now.vh} CSS px (was ${before.vw}×${before.vh}). Only this tab's page is resized; the browser window is unchanged. `
      + 'Element positions changed: take a new screenshot before using coordinates. '
      + 'The override lasts until reset: true, or until cctether detaches from the tab (5 min without tool calls, or a pause).';
  }
  return { content: [text(msg)] };
}

async function resetViewport({ tab, s }) {
  const before = await s.lib('metrics');
  const had = s.viewport;
  // Sent even without a known override: harmless, and it clears one left by an earlier
  // service-worker instance. Only the size override is cleared: set_color_scheme's stays.
  // If this fails, the record stays (also the lost one dropSession() makes if the session ends
  // meanwhile).
  await s.send('Emulation.clearDeviceMetricsOverride');
  // The session ended while the command was on its way: what dropSession() recorded stands, and
  // a newer session on this tab is not this call's business.
  if (s.closed) throw detachedError(tab.id);
  s.viewport = null;
  clearLostEmulation(tab.id, 'viewport');
  // Right after the clear, a background tab can report an earlier override's size for up to about
  // a second before its real one. So wait for the real size as the browser knows it (an override
  // doesn't change the tab's size in chrome.tabs), and keep a hidden tab painting meanwhile,
  // which makes Chrome apply the change within a few frames. Also without a known override: one
  // may be left from an earlier worker instance or a reset that timed out.
  const real = await realViewport(tab.id);
  const back = real
    ? (m) => Math.abs(m.vw - real.vw) <= 1 && Math.abs(m.vh - real.vh) <= 1
    : had ? (m) => m.vw !== before.vw || m.vh !== before.vh : () => true;
  const now = await whilePainting(s, tab.id, () => pollMetrics(s, back, RESET_SETTLE_MS));
  if (s.closed) throw detachedError(tab.id); // ended during the wait: no "back at" report
  let msg;
  if (!had) {
    if (now && back(now)) {
      msg = `Tab ${tab.id} has no viewport override from cctether; its viewport is ${now.vw}×${now.vh} CSS px.`;
    } else if (now) {
      msg = `Tab ${tab.id} has no viewport override from cctether, but the page reports ${now.vw}×${now.vh} CSS px where the browser says ${Math.round(real.vw)}×${Math.round(real.vh)} (it may be loading or busy). Check with screenshot.`;
    } else {
      msg = `Tab ${tab.id} has no viewport override from cctether; the page did not report its size in time (it may be loading or busy).`;
    }
  } else if (now && back(now)) {
    msg = `Tab ${tab.id} is back at its real viewport, ${now.vw}×${now.vh} CSS px (the override was ${had.width}×${had.height}).`;
  } else if (now) {
    msg = `Cleared the ${had.width}×${had.height} viewport override on tab ${tab.id}, but the page still reports ${now.vw}×${now.vh} CSS px (it may be loading or busy). Check with screenshot.`;
  } else {
    msg = `Cleared the ${had.width}×${had.height} viewport override on tab ${tab.id}, but the page did not report its size in time (it may be loading or busy). Check with screenshot.`;
  }
  return { content: [text(msg)] };
}

/** The tab's real viewport in CSS px according to the browser, or null if it doesn't say. */
async function realViewport(tabId) {
  try {
    const [t, zoom] = await Promise.all([chrome.tabs.get(tabId), pageZoom(tabId)]);
    if (t.width > 0 && t.height > 0) return { vw: t.width / zoom, vh: t.height / zoom };
  } catch { /* the tab is gone */ }
  return null;
}

/** Run fn while a background tab is made to paint (the same tiny screencast as capture() uses). */
async function whilePainting(s, tabId, fn) {
  const hidden = await isHiddenTab(tabId);
  if (hidden) {
    await s.send('Page.startScreencast', SCREENCAST, { timeoutMs: 3000 }).catch(() => {});
  }
  try {
    return await fn();
  } finally {
    // A tab has one screencast. Stopping it while a screenshot is capturing on this tab would
    // stall that capture (up to 8 s, then it brings the tab to the front); capture() stops the
    // screencast itself when it is done.
    if (hidden && !s.capturing) s.send('Page.stopScreencast', {}, { timeoutMs: 3000 }).catch(() => {});
  }
}

// ---- set_color_scheme --------------------------------------------------------------------------
//
// Emulates the prefers-color-scheme media feature (Emulation.setEmulatedMedia). The browser's own
// setting is not changed; a site's own theme switch or saved theme is not touched.

const SCHEME_SETTLE_MS = 1000;
const READ_MS = 1000;

/** This session's media emulation, as cctether set it. */
const mediaConfig = (s) => ({ colorScheme: s.colorScheme });

/**
 * The only place that sends Emulation.setEmulatedMedia. Each call submits the WHOLE media
 * emulation config: anything not in it (the media type, other features) is cleared. So it is
 * built only from the live session's own config, never from a lost record (that would quietly
 * re-apply an override that ended), and any future media emulation (reduced motion, print) must
 * be added to mediaConfig and sent from here.
 */
function sendMedia(s, config) {
  return s.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: config.colorScheme ?? '' }],
  });
}

const schemeOf = (m) => (m.dark ? 'dark' : 'light');

export async function setColorScheme(ctx, args) {
  return queued(ctx.s, () => (args.scheme === 'system' ? removeColorScheme(ctx) : applyColorScheme(ctx, args.scheme)));
}

async function applyColorScheme({ tab, s }, scheme) {
  const before = await s.lib('metrics');
  // Record first, then send, as setViewport does.
  if (s.closed) throw detachedError(tab.id);
  const prev = s.colorScheme;
  s.colorScheme = scheme;
  saveEmulations();
  try {
    await sendMedia(s, mediaConfig(s));
  } catch (e) {
    if (e instanceof CdpError && !s.closed) {
      s.colorScheme = prev;
      saveEmulations();
    }
    throw e;
  }
  if (s.closed) throw detachedError(tab.id);
  clearLostEmulation(tab.id, 'scheme');
  const now = await pollMetrics(s, (m) => schemeOf(m) === scheme, SCHEME_SETTLE_MS);
  if (s.closed) throw detachedError(tab.id); // ended during the wait: no "remains active" report
  let msg;
  if (!now) {
    msg = `Color scheme override set to ${scheme} for tab ${tab.id}, but the page did not answer in time (it may be loading or busy). Check with screenshot.`;
  } else if (schemeOf(now) !== scheme) {
    msg = `Requested ${scheme}, but the page still reports a ${schemeOf(now)} color scheme. The override remains active (scheme: "system" clears it).`;
  } else {
    msg = `Tab ${tab.id} now sees a ${scheme} color scheme (the page reported ${schemeOf(before)} before). Only this tab is affected; the browser's own setting is unchanged. `
      + 'Only the prefers-color-scheme media feature changes: a site\'s own theme switch or saved theme is not touched. '
      + 'Take a new screenshot to see the result. '
      + 'The override lasts until scheme: "system", or until cctether detaches from the tab (5 min without tool calls, or a pause).';
  }
  return { content: [text(msg)] };
}

async function removeColorScheme({ tab, s }) {
  const had = s.colorScheme;
  // Sent even without a known override (harmless; clears one an earlier worker instance left).
  await sendMedia(s, { ...mediaConfig(s), colorScheme: null });
  if (s.closed) throw detachedError(tab.id); // what dropSession() recorded stands
  s.colorScheme = null;
  clearLostEmulation(tab.id, 'scheme');
  // Read once, without waiting for a change: when the override equaled the browser's own scheme,
  // nothing changes. (Retried only while the read itself fails, e.g. during a navigation.)
  const now = await pollMetrics(s, () => true, READ_MS);
  if (s.closed) throw detachedError(tab.id);
  const what = had
    ? `Removed the ${had} color scheme override from tab ${tab.id}`
    : `Tab ${tab.id} has no color scheme override from cctether`;
  const page = now
    ? (had ? `; the page now reports ${schemeOf(now)}.` : `; the page reports ${schemeOf(now)}.`)
    : '; the page did not answer in time.';
  return { content: [text(what + page)] };
}

// ---- evaluate ----------------------------------------------------------------------------------

const EVAL_MAX = 20000;

/** The page went away around a running expression (Chrome: "Inspected target navigated or closed", ...). */
const navigatedError = () => new ToolError('navigated', 'The page navigated or reloaded while the expression was running (or just as it was about to start), so there is no result. '
  + 'If the expression itself navigated (clicked a link, submitted a form, changed location), that part probably worked. '
  + 'Check the page with read_page or wait_for before running it again, in case it already had an effect.');

// Each call gets its own object group: releasing a shared one at the end of one call would free
// the result of another call running at the same time.
let evalSeq = 0;

export async function evaluate({ tab, s }, args) {
  const timeoutMs = args.timeout_ms ?? 10000;
  const world = args.world ?? 'page';
  const group = `cctether-eval-${++evalSeq}`;
  const params = {
    expression: args.expression,
    replMode: true,
    awaitPromise: true,
    returnByValue: false,
    userGesture: true,
    timeout: timeoutMs,
    objectGroup: group,
  };
  if (world === 'isolated') params.contextId = await s.guardDialog(s.world());
  const timeoutError = () => new ToolError('timeout', `The expression did not finish within ${timeoutMs} ms (a long loop, or a promise that never settles?). Pass a larger timeout_ms if it needs more time.`);
  let r;
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      r = await s.raceDialog(s.send('Runtime.evaluate', params, { timeoutMs: timeoutMs + 500 }));
      break;
    } catch (e) {
      if (e instanceof ToolError && e.code === 'timeout') throw timeoutError();
      if (isContextGone(e)) {
        // "Cannot find context with specified id" comes back before anything runs: the isolated
        // world we had is from a page that's gone. Safe to run once in the new page's world. (A
        // script cut off by a navigation gets "Inspected target navigated or closed" instead.)
        if (world === 'isolated' && attempt === 0 && /Cannot find context/i.test(e.cdpMessage)) {
          s.resetWorld();
          params.contextId = await s.guardDialog(s.world());
          continue;
        }
        throw navigatedError();
      }
      // A script stopped by Runtime.evaluate's own `timeout` ends with a bare "Internal error".
      if (e instanceof CdpError && Date.now() - t0 >= timeoutMs * 0.9) throw timeoutError();
      throw e;
    }
  }
  const dialogResult = (d) => ({
    content: [text(`The expression opened a JavaScript ${d.type} dialog (${q(d.message, 200)}), so its result is not available. The page is frozen until the dialog is closed: call handle_dialog.`)],
  });
  if (r.dialog) return dialogResult(r.dialog);
  let res = r.value;
  let awaited = false;
  try {
    // In REPL mode only a top-level `await` is awaited; a Promise that is the value of the
    // expression (an async function's result) comes back as is. Wait for it within the same time.
    if (!res.exceptionDetails && res.result?.subtype === 'promise' && res.result.objectId) {
      const left = timeoutMs - (Date.now() - t0);
      if (left <= 0) throw timeoutError();
      let ar;
      try {
        ar = await s.raceDialog(s.send('Runtime.awaitPromise', { promiseObjectId: res.result.objectId, returnByValue: false }, { timeoutMs: left }));
      } catch (e) {
        if (e instanceof ToolError && e.code === 'timeout') throw timeoutError();
        if (isContextGone(e)) throw navigatedError();
        throw e;
      }
      if (ar.dialog) return dialogResult(ar.dialog);
      res = ar.value;
      awaited = true;
    }
    if (res.exceptionDetails) {
      const msg = exceptionToText(res.exceptionDetails);
      if (/terminat/i.test(msg) && !/Uncaught \w*Error: /.test(msg.replace(/terminat/gi, ''))) throw timeoutError();
      throw new ToolError('js_error', `The expression threw an error.\n${untrusted(msg)}`);
    }
    const o = res.result;
    let type = o.subtype && o.subtype !== 'null' ? o.subtype : o.type;
    if (o.subtype === 'null') type = 'null';
    let json;
    if (o.objectId) {
      const sr = await s.guardDialog(s.send('Runtime.callFunctionOn', {
        objectId: o.objectId, functionDeclaration: SERIALIZE_FN, arguments: [{ value: 20000 }], returnByValue: true,
      }, { timeoutMs: 5000 })).catch((e) => { throw isContextGone(e) ? navigatedError() : e; });
      json = sr.exceptionDetails ? `[could not serialise: ${exceptionToText(sr.exceptionDetails)}]` : String(sr.result.value);
      if (o.type === 'object' && o.className && !o.subtype && o.className !== 'Object') type = `object ${o.className}`;
    } else if (o.type === 'undefined') {
      json = 'undefined';
    } else if (o.unserializableValue) {
      json = o.unserializableValue;
    } else {
      json = JSON.stringify(o.value);
    }
    let note = '';
    if (json.length > EVAL_MAX) {
      note = `\nTruncated: showing ${EVAL_MAX} of ${json.length} characters. Return a smaller value (e.g. pick fields or slice) to see the rest.`;
      json = `${json.slice(0, EVAL_MAX)}…`;
    }
    const where = world === 'isolated' ? 'isolated world' : 'page';
    return { content: [text(`Result (${type}, ran in the ${where}${awaited ? ', after awaiting the returned Promise' : ''}):\n${untrusted(json)}${note}`)] };
  } finally {
    s.send('Runtime.releaseObjectGroup', { objectGroup: group }, { timeoutMs: 2000 }).catch(() => {});
  }
}

// ---- wait_for ----------------------------------------------------------------------------------

/** "the text "Ready"" / "an element matching ".status" with text "Ready"". */
function waitWhat(c) {
  return c.selector
    ? `an element matching ${q(c.selector, 200)}${c.text != null ? ` with text ${q(c.text, 200)}` : ''}`
    : `the text ${q(c.text, 200)}`;
}

/**
 * Poll until condition c ({ text?, selector?, gone?, doc? }) holds or `deadline` passes. Read-only:
 * it only looks at the page. With doc, only that document counts (changed: it navigated away).
 * Returns { met, changed?, first (it held at the first check), ms, desc }.
 */
async function waitUntil(s, c, deadline) {
  const started = Date.now();
  let first = true;
  for (;;) {
    if (s.closed) throw new ToolError('no_tab', 'The tab was closed or the debugger was detached while waiting.');
    if (s.dialog) throw dialogError(s.tabId, s.dialog);
    let r = null;
    try {
      r = await s.lib('waitCheck', [{ text: c.text, selector: c.selector }], {
        timeoutMs: Math.max(500, Math.min(3000, deadline - Date.now())),
      });
    } catch (e) {
      if (e instanceof ToolError && ['bad_args', 'dialog_open', 'no_tab', 'stale_ref'].includes(e.code)) throw e;
      // Navigation in progress or the page is busy: keep polling.
    }
    // Bound to one document (navigate's wait_for): another navigation ends the wait.
    if (r && c.doc != null && r.doc !== c.doc) {
      return { met: false, changed: true, first, ms: Date.now() - started, desc: '' };
    }
    if (c.moved?.()) return { met: false, changed: true, first, ms: Date.now() - started, desc: '' };
    if (r && r.found !== !!c.gone) {
      let desc = r.desc;
      if (!c.gone && !c.selector) {
        try { desc = (await s.lib('locateText', [{ text: c.text, doc: r.doc }], { timeoutMs: 3000 })).desc; } catch { /* busy: skip */ }
      }
      return { met: true, first, ms: Date.now() - started, desc };
    }
    if (r) first = false;
    if (Date.now() >= deadline) return { met: false, first, ms: Date.now() - started, desc: '' };
    // Often at first, then once a second for long waits.
    await sleep(Math.min(Date.now() - started < 10000 ? 200 : 1000, Math.max(0, deadline - Date.now())));
  }
}

/** The sentence for a met condition. */
function metText(c, w) {
  const what = waitWhat(c);
  const What = what[0].toUpperCase() + what.slice(1);
  const secs = (w.ms / 1000).toFixed(1);
  if (c.gone) return w.first ? `${What} was not there at the first check.` : `${What} is gone (after ${secs} s).`;
  const at = w.desc ? `\n${untrusted(w.desc)}` : '';
  return w.first
    ? `${What} was already there when the wait started (found at the first check, so it may not be the new content you are waiting for).${at}`
    : `Found ${what} after ${secs} s.${at}`;
}

export async function waitFor({ s }, args) {
  if (args.text == null && args.selector == null) {
    throw new ToolError('bad_args', 'Pass `text`, `selector`, or both.');
  }
  const timeoutMs = args.timeout_ms ?? 10000;
  const c = { text: args.text, selector: args.selector, gone: args.gone === true };
  const w = await waitUntil(s, c, Date.now() + timeoutMs);
  if (w.met) return { content: [text(metText(c, w))] };
  const what = waitWhat(c);
  throw new ToolError('timeout', c.gone
    ? `Waited ${timeoutMs} ms, but ${what} is still there.`
    : `Waited ${timeoutMs} ms, but ${what} did not appear. Check the page with read_page or screenshot, or wait longer with timeout_ms.`);
}

/**
 * navigate's wait_for: after the load, wait for the condition in the time left. Not reaching it is
 * not an error: the page did load. Only the page that was just loaded counts: `moved()` says the
 * tab has committed another navigation since (when the caller watched the load), and the page's
 * document token is compared on every check. Returns a sentence.
 */
async function afterLoad(s, cond, deadline, moved = () => false, loadedAt = null) {
  const c = { text: cond.text, selector: cond.selector, moved };
  const what = waitWhat(c);
  // The loaded page's token, retried while the page is busy right after a load. A dialog, or
  // losing the tab, is reported at once.
  let m = null;
  while (!m && !moved() && Date.now() < deadline) {
    try {
      m = await s.lib('metrics', [], { timeoutMs: Math.max(500, Math.min(3000, deadline - Date.now())) });
    } catch (e) {
      if (e instanceof ToolError && ['dialog_open', 'no_tab'].includes(e.code)) throw e;
      await sleep(100);
    }
  }
  if (!m && !moved()) return `But cctether could not read the page before the time ran out, so it did not wait for ${what}: use wait_for.`;
  if (Date.now() >= deadline) return `There was no time left to wait for ${what}: use wait_for.`;
  c.doc = m?.doc;
  // Without a record of commits (cctether attached after the load), a document whose navigation
  // started after the load had finished is another page (same address or not).
  const away = moved() || (loadedAt != null && m != null && m.t0 > loadedAt);
  const w = away ? { met: false, changed: true } : await waitUntil(s, c, deadline);
  if (w.met) return metText(c, w);
  if (w.changed) {
    const t = await tabSummary(s.tabId);
    return `But the page navigated again (now ${t.url}) before ${waitWhat(c)} appeared, so cctether stopped waiting. Check the page with read_page or screenshot.`;
  }
  return `But ${waitWhat(c)} did not appear within the remaining ${(w.ms / 1000).toFixed(1)} s (the page may still be rendering): use wait_for to keep waiting, there is no need to load it again.`;
}

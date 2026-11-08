// Tools that read or drive a page as a whole: navigate, read_page, find, screenshot, evaluate,
// wait_for. Each gets ctx = { tab, s } where s is the tab's debugger session (debugger.js).

import { ToolError } from './errors.js';
import { untrusted, q, page, sleep, normalizeUrl, imageSize } from './util.js';
import { exceptionToText } from './format.js';
import { isRestrictedUrl, restrictedMessage } from '../tabs.js';
import { dialogError, CdpError, isContextGone } from '../debugger.js';
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
  const t = await tabSummary(tab.id);
  return { content: [text(loadedText(t, null, ok, timeoutMs))], tab: t };
}

export async function navigate(ctx, args) {
  const { tab, s } = ctx;
  if ((args.url == null) === (args.action == null)) {
    throw new ToolError('bad_args', 'Pass either `url`, or `action` ("back", "forward" or "reload").');
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
    s.resetWorld();
    const t = await tabSummary(tab.id);
    return { content: [text(loadedText(t, w.st, ok, timeoutMs))], tab: t };
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
    header = `Title: ${r.title}\nURL: ${r.url}\n${r.total} interactive elements${r.total > r.lines.length ? ` (first ${r.lines.length} listed)` : ''}`
      + `${sel ? ` inside ${sel}` : ''}. Viewport ${r.vw}×${r.vh}; ↑ ↓ ← → = outside the viewport in that direction.`;
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
  const r = await s.lib('find', [{ selector: args.selector, limit: args.limit ?? 20 }]);
  if (!r.count) {
    return { content: [text(`No elements match ${q(args.selector, 200)}.`)] };
  }
  const lines = r.items.map((it) => {
    const [x, y, w, h] = it.rect;
    return `[${it.ref}] ${it.tag}${it.attrs.length ? ` ${it.attrs.join(' ')}` : ''}${it.text ? ` ${JSON.stringify(it.text)}` : ''} at (${x}, ${y}) ${w}×${h}, ${it.vis}`;
  });
  const head = `${r.count} element${r.count === 1 ? '' : 's'} match ${q(args.selector, 200)}${r.count > r.items.length ? ` (showing the first ${r.items.length})` : ''}.`;
  return {
    content: [text(`${head}\n${untrusted(lines.join('\n'))}\nPositions are viewport CSS pixels (x, y, width×height). Pass a [number] as \`ref\` to other tools.`)],
  };
}

// ---- screenshot --------------------------------------------------------------------------------

const MAX_EDGE = 1568;
const FULL_PAGE_MAX_HEIGHT = 16000;

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
  if (hidden) {
    const frame = s.waitFor((m) => m === 'Page.screencastFrame', 1000);
    await s.send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16, everyNthFrame: 1 }, { timeoutMs: 3000 }).catch(() => {});
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
    if (hidden) s.send('Page.stopScreencast', {}, { timeoutMs: 3000 }).catch(() => {});
  }
}

/** Three decimals: at 2000 → 1568 px, 1.28 instead of 1.2755 would be 7 px off at the far edge. */
const round3 = (n) => Math.round(n * 1000) / 1000;

export async function screenshot({ tab, s }, args) {
  const format = args.format ?? 'jpeg';
  const quality = args.quality ?? 75;
  let clip;
  let mode;
  let beyond = false;
  let cut = '';
  let origin = null;
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
    origin = { x: Math.round(r.x), y: Math.round(r.y) };
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
  const fit = Math.min(1, MAX_EDGE / Math.max(clip.width, clip.height));
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
  const ratio = round3(clip.width / size.width);
  const scaled = Math.abs(ratio - 1) >= 0.01;
  // Say exactly how image points map to the CSS pixels click/hover take: a scaled image whose
  // coordinates are used as-is clicks the wrong place.
  const k = (v) => (scaled ? `${v} × ${ratio}` : v);
  let desc = `${size.width}×${size.height} ${format.toUpperCase()}, ${mode}, `;
  desc += scaled ? `scaled down to fit ${MAX_EDGE} px: 1 image px = ${ratio} CSS px.` : '1 px = 1 CSS px.';
  if (mode === 'viewport') {
    desc += scaled
      ? ` Image coordinates are NOT click coordinates here: for click/hover at image point (x, y), pass x = ${k('x')}, y = ${k('y')}. Clicking by ref or selector needs no conversion.`
      : ' Image coordinates are viewport coordinates for click/hover.';
  } else if (mode === 'full page') {
    desc += ` Page y = ${k('image y')}; the viewport is currently scrolled to y=${Math.round(m.scrollY)}.`;
  } else if (origin) {
    desc += ` Image point (x, y) is viewport (${origin.x} + ${k('x')}, ${origin.y} + ${k('y')}).`;
  }
  desc += cut;
  return {
    content: [
      { type: 'image', data: r.data, mimeType: `image/${format}` },
      text(desc),
    ],
  };
}

// ---- evaluate ----------------------------------------------------------------------------------

const EVAL_MAX = 20000;

/** The page went away around a running expression (Chrome: "Inspected target navigated or closed", ...). */
const navigatedError = () => new ToolError('navigated', 'The page navigated or reloaded while the expression was running (or just as it was about to start), so there is no result. '
  + 'If the expression itself navigated (clicked a link, submitted a form, changed location), that part probably worked. '
  + 'Check the page with read_page or wait_for before running it again, in case it already had an effect.');

export async function evaluate({ tab, s }, args) {
  const timeoutMs = args.timeout_ms ?? 10000;
  const world = args.world ?? 'page';
  const params = {
    expression: args.expression,
    replMode: true,
    awaitPromise: true,
    returnByValue: false,
    userGesture: true,
    timeout: timeoutMs,
    objectGroup: 'cctether-eval',
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
  if (r.dialog) {
    return {
      content: [text(`The expression opened a JavaScript ${r.dialog.type} dialog (${q(r.dialog.message, 200)}), so its result is not available. The page is frozen until the dialog is closed: call handle_dialog.`)],
    };
  }
  const res = r.value;
  try {
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
    return { content: [text(`Result (${type}, ran in the ${where}):\n${untrusted(json)}${note}`)] };
  } finally {
    s.send('Runtime.releaseObjectGroup', { objectGroup: 'cctether-eval' }, { timeoutMs: 2000 }).catch(() => {});
  }
}

// ---- wait_for ----------------------------------------------------------------------------------

export async function waitFor({ s }, args) {
  if (args.text == null && args.selector == null) {
    throw new ToolError('bad_args', 'Pass `text`, `selector`, or both.');
  }
  const timeoutMs = args.timeout_ms ?? 10000;
  const gone = args.gone === true;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const what = args.selector
    ? `an element matching ${q(args.selector, 200)}${args.text != null ? ` with text ${q(args.text, 200)}` : ''}`
    : `the text ${q(args.text, 200)}`;
  for (;;) {
    if (s.closed) throw new ToolError('no_tab', 'The tab was closed or the debugger was detached while waiting.');
    if (s.dialog) throw dialogError(s.tabId, s.dialog);
    let r = null;
    try {
      r = await s.lib('waitCheck', [{ text: args.text, selector: args.selector }], {
        timeoutMs: Math.max(500, Math.min(3000, deadline - Date.now())),
      });
    } catch (e) {
      if (e instanceof ToolError && ['bad_args', 'dialog_open', 'no_tab', 'stale_ref'].includes(e.code)) throw e;
      // Navigation in progress or the page is busy: keep polling.
    }
    if (r && r.found !== gone) {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const msg = gone
        ? `${what[0].toUpperCase()}${what.slice(1)} is gone (after ${secs} s).`
        : `Found ${what} after ${secs} s.${r.desc ? `\n${untrusted(r.desc)}` : ''}`;
      return { content: [text(msg)] };
    }
    if (Date.now() >= deadline) {
      throw new ToolError('timeout', gone
        ? `Waited ${timeoutMs} ms, but ${what} is still there.`
        : `Waited ${timeoutMs} ms, but ${what} did not appear. Check the page with read_page or screenshot, or wait longer with timeout_ms.`);
    }
    await sleep(200);
  }
}


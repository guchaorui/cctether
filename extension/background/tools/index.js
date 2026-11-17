// Tool implementations. Names and arguments match server/src/tools.js (a test checks the names).
//
// runTool(name, args) → { content: [{type:'text', text} | {type:'image', data, mimeType}], tab? }
// Expected failures throw ToolError(code, message) with these codes:
//   no_tab, not_shared, restricted_url, dialog_open, debugger_busy, no_element, stale_ref,
//   timeout, js_error, navigated, bad_args, not_found, emulation_changed, internal
// ("paused" and "not connected" are handled by the caller.) When the failing call had resolved
// a tab, the error carries it as `error.tab` ({ id, title, url }).

import { ToolError } from './errors.js';
import { A, int, bool, str, oneOf, strOrStrings, listOf, pattern, checkArgs } from './args.js';
import { resolveTab, setCurrentTab, isRestrictedUrl, restrictedMessage } from '../tabs.js';
import { session, dialogError, takeLostEmulation } from '../debugger.js';
import { listTabs, openTab, closeTab, listExtensions, reloadExtension, tabSummary } from './browser.js';
import {
  navigate, readPage, find, screenshot, resizeViewport, setColorScheme, evaluate, waitFor,
} from './page.js';
import { click, hover, type, pressKey, scroll, selectOption } from './input.js';
import { consoleMessages, networkRequests, handleDialog } from './logs.js';

export { ToolError };

const pointer = { ref: A.ref, selector: A.selector, x: A.x, y: A.y, tab: A.tab };

/**
 * kind: 'browser' = run(args); 'page' = resolve tab, attach debugger, run({ tab, s }, args).
 * restrictedOk: the tool works even if the tab shows a restricted page (s is null then).
 * dialogOk: the tool may run while a JS dialog is open.
 * ownsEmulation: the tool manages an emulation itself (resize_viewport, set_color_scheme), so it
 *   neither shows nor consumes the "emulation ended" note (see runPageTool).
 */
const TOOLS = {
  list_tabs: { kind: 'browser', args: {}, run: listTabs },
  open_tab: { kind: 'browser', args: { url: str(0, 8192), active: bool() }, run: openTab },
  close_tab: { kind: 'browser', args: { tab: A.tab }, required: ['tab'], run: closeTab },
  navigate: {
    kind: 'page', restrictedOk: true,
    args: { url: str(1, 8192), action: oneOf('back', 'forward', 'reload'), tab: A.tab, timeout_ms: A.timeout(120000) },
    run: navigate,
  },
  read_page: {
    kind: 'page',
    args: {
      mode: oneOf('text', 'interactive', 'html'), selector: A.selector, offset: int(0),
      max_chars: int(500, 100000), tab: A.tab,
    },
    run: readPage,
  },
  find: { kind: 'page', args: { selector: A.selector, limit: int(1, 200), tab: A.tab }, required: ['selector'], run: find },
  screenshot: {
    kind: 'page',
    args: {
      full_page: bool(), ref: A.ref, selector: A.selector, format: oneOf('jpeg', 'png'),
      quality: int(1, 100), tab: A.tab,
    },
    run: screenshot,
  },
  resize_viewport: {
    kind: 'page', ownsEmulation: true,
    args: { width: int(200, 3840), height: int(200, 3840), reset: bool(), tab: A.tab },
    run: resizeViewport,
  },
  set_color_scheme: {
    kind: 'page', ownsEmulation: true,
    args: { scheme: oneOf('dark', 'light', 'system'), tab: A.tab },
    required: ['scheme'],
    run: setColorScheme,
  },
  click: {
    kind: 'page',
    args: {
      ...pointer, button: oneOf('left', 'right', 'middle'), click_count: int(1, 3),
      modifiers: listOf(4, oneOf('Alt', 'Control', 'Meta', 'Shift')),
    },
    run: click,
  },
  type: {
    kind: 'page',
    args: { text: str(0, 100000), ref: A.ref, selector: A.selector, clear: bool(), submit: bool(), tab: A.tab },
    required: ['text'],
    run: type,
  },
  press_key: { kind: 'page', args: { key: str(1, 100), repeat: int(1, 50), tab: A.tab }, required: ['key'], run: pressKey },
  scroll: {
    kind: 'page',
    args: { ...pointer, direction: oneOf('up', 'down', 'left', 'right'), amount: int(1, 100000) },
    run: scroll,
  },
  hover: { kind: 'page', args: pointer, run: hover },
  select_option: {
    kind: 'page',
    args: { ref: A.ref, selector: A.selector, value: strOrStrings(100), tab: A.tab },
    required: ['value'],
    run: selectOption,
  },
  wait_for: {
    kind: 'page',
    args: { text: str(1, 1000), selector: A.selector, gone: bool(), timeout_ms: A.timeout(120000), tab: A.tab },
    run: waitFor,
  },
  evaluate: {
    kind: 'page',
    args: { expression: str(1, 200000), world: oneOf('page', 'isolated'), timeout_ms: A.timeout(120000), tab: A.tab },
    required: ['expression'],
    run: evaluate,
  },
  console_messages: {
    kind: 'page',
    args: {
      level: oneOf('error', 'warning', 'all'), pattern: str(0, 500), limit: int(1, 500), clear: bool(), tab: A.tab,
    },
    run: consoleMessages,
  },
  network_requests: {
    kind: 'page',
    args: {
      id: int(1), pattern: str(0, 500),
      type: oneOf('document', 'xhr', 'fetch', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket', 'other'),
      failed: bool(), limit: int(1, 500), clear: bool(), tab: A.tab,
    },
    run: networkRequests,
  },
  handle_dialog: {
    kind: 'page', dialogOk: true,
    args: { accept: bool(), text: str(0, 10000), tab: A.tab },
    required: ['accept'],
    run: handleDialog,
  },
  list_extensions: { kind: 'browser', args: {}, run: listExtensions },
  reload_extension: {
    kind: 'browser',
    args: { id: pattern(/^[a-p]{32}$/, 'an extension id (32 letters a–p) from list_extensions') },
    required: ['id'],
    run: reloadExtension,
  },
};

export const TOOL_NAMES = Object.freeze(Object.keys(TOOLS));

/** Argument names per tool (tests compare them with the server's JSON schemas). */
export const TOOL_ARGS = Object.freeze(Object.fromEntries(Object.entries(TOOLS).map(([n, d]) => [n, Object.keys(d.args)])));

// Emulations that ended when the debugger let go of the tab are reported once, on the next tool
// call. The text doesn't guess the exact cause and doesn't claim the page is back to normal now.
const ENDED = 'ended when cctether detached from this tab (for example after 5 minutes without tool calls, or a pause)';

/** What ended, for a lost record { viewport?, scheme? }. */
function lostWhat(e) {
  const vp = e.viewport && `${e.viewport.width}×${e.viewport.height} viewport override`;
  if (vp && e.scheme) return `${vp} (resize_viewport) and the ${e.scheme} color scheme (set_color_scheme)`;
  return vp ? `${vp} set with resize_viewport` : `${e.scheme} color scheme set with set_color_scheme`;
}

function lostNote(e) {
  const again = e.viewport && e.scheme ? 'Set them again if you still need them.'
    : `Call ${e.viewport ? 'resize_viewport' : 'set_color_scheme'} again if you still need it.`;
  return `Note: the ${lostWhat(e)} ${ENDED}. ${again}`;
}

/** Names everything that was lost: the record is used up by this refusal. */
const emulationChanged = (e) => new ToolError('emulation_changed', `Not done. The ${lostWhat(e)} ${ENDED}, `
  + 'so the page may look different from your last screenshot and (x, y) may point somewhere else. Take a new screenshot (or set it again), then retry.');

/** Append the note to an error's message (unexpected errors too: runTool keeps the message). */
function withNote(e, note) {
  if (e instanceof Error) {
    e.message = `${e.message}\n${note}`;
    return e;
  }
  return new Error(`${String(e)}\n${note}`);
}

async function runPageTool(def, args) {
  const tab = await resolveTab(args.tab);
  setCurrentTab(tab.id);
  let summary = null;
  let lost = null;
  try {
    const url = tab.pendingUrl || tab.url;
    let s = null;
    if (await isRestrictedUrl(url)) {
      if (!def.restrictedOk) {
        throw new ToolError('restricted_url', `Tab ${tab.id} shows ${url.split(/[?#]/)[0]}. ${restrictedMessage(url)} Navigate the tab to a web page first (navigate), or use open_tab.`);
      }
    } else {
      s = await session(tab.id);
    }
    if (s && s.dialog && !def.dialogOk) throw dialogError(tab.id, s.dialog);
    // Only for a shared tab cctether is attached to and that is not blocked: taking the record
    // means the note is shown now.
    if (s && !def.ownsEmulation) {
      const e = await takeLostEmulation(tab.id);
      // Coordinates were most likely measured on a screenshot taken under the emulation (a dark
      // theme can hide or move things too): refuse once rather than click somewhere else. The
      // record is used up, so a retry runs.
      if (e && (args.x != null || args.y != null)) throw emulationChanged(e);
      lost = e;
    }
    if (s) s.busy++;
    try {
      const result = await def.run({ tab, s }, args);
      result.tab ??= await tabSummary(tab.id);
      if (lost) result.content.push({ type: 'text', text: lostNote(lost) });
      return result;
    } finally {
      if (s) { s.busy--; s.touch(); }
    }
  } catch (e) {
    summary = await tabSummary(tab.id);
    if (lost) e = withNote(e, lostNote(lost));
    if (e && typeof e === 'object') e.tab ??= summary;
    throw e;
  }
}

/**
 * Run one tool. Never evaluates anything received here in the extension's own context:
 * `evaluate` sends its expression to the page through CDP.
 */
export async function runTool(name, args) {
  const def = typeof name === 'string' && Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!def) throw new ToolError('bad_args', `Unknown tool ${JSON.stringify(String(name)).slice(0, 80)}. Tools: ${TOOL_NAMES.join(', ')}.`);
  try {
    const clean = checkArgs(name, args, def.args, def.required);
    return def.kind === 'page' ? await runPageTool(def, clean) : await def.run(clean);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    const err = new ToolError('internal', `${name} failed unexpectedly: ${e?.message ?? e}`);
    if (e?.tab) err.tab = e.tab;
    throw err;
  }
}

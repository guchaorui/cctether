// Mouse and keyboard tools: click, hover, drag, type, press_key, scroll, select_option.
// Input goes through CDP Input.* so the page sees real (trusted) events.

import { ToolError } from './errors.js';
import { q, untrusted, sleep } from './util.js';
import { isShared } from '../tabs.js';
import { dialogError, describeDialog, dialogHint } from '../debugger.js';
import { tabSummary, isMac } from './browser.js';
import { shotPoint, whilePainting } from './page.js';

const text = (t) => ({ type: 'text', text: t });
const bad = (m) => new ToolError('bad_args', m);
const r0 = (n) => Math.round(n);

// ---- shared helpers ---------------------------------------------------------------------------

const BUTTON_BITS = { left: 1, right: 2, middle: 4 };
const MOD_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function modifierBits(list) {
  let bits = 0;
  for (const m of list ?? []) bits |= MOD_BITS[m] ?? 0;
  return bits;
}

async function mouseClick(s, x, y, { button = 'left', clickCount = 1, modifiers = 0, move = true } = {}) {
  if (move) await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers, button: 'none' });
  for (let i = 1; i <= clickCount; i++) {
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, modifiers, button, buttons: BUTTON_BITS[button], clickCount: i });
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, modifiers, button, buttons: 0, clickCount: i });
  }
}

/** Check how an element was named: ref alone, or selector and/or text. */
function checkElementArgs(args) {
  if (args.ref != null && (args.selector != null || args.text != null)) throw bad('Pass `ref` alone, or `selector` and/or `text`, not both kinds.');
}

/**
 * The viewport point for a point argument: x, y in viewport CSS px, or with `screenshot`, a point
 * on that screenshot. Returns { x, y, from } (from: how the point was given, for the result).
 */
async function pointArg(s, tabId, args) {
  if (args.x == null || args.y == null) throw bad(args.screenshot != null ? 'Pass `x` and `y` (a point on the screenshot) with `screenshot`.' : 'Pass both `x` and `y`.');
  if (args.screenshot == null) return { x: args.x, y: args.y, from: '' };
  const p = await shotPoint(s, tabId, args.screenshot, args.x, args.y);
  return { x: p.x, y: p.y, from: ` (point (${r0(args.x)}, ${r0(args.y)}) of screenshot ${args.screenshot}${p.note})` };
}

/** Resolve ref / selector / text / (x, y) to a viewport point. */
async function targetPoint(s, tabId, args) {
  const hasEl = args.ref != null || args.selector != null || args.text != null;
  const hasXY = args.x != null || args.y != null || args.screenshot != null;
  checkElementArgs(args);
  if (hasEl && hasXY) throw bad('Pass either an element (`ref`, `selector`, `text`) or a point (`x` and `y`), not both.');
  if (hasXY) {
    const p = await pointArg(s, tabId, args);
    const r = await s.lib('at', [{ x: p.x, y: p.y }]);
    return { x: p.x, y: p.y, desc: r.desc, point: true, covered: null, from: p.from };
  }
  if (!hasEl) throw bad('Pass `ref`, `selector` or `text` (or `x` and `y`) to say where.');
  return s.lib('point', [{ ref: args.ref, selector: args.selector, text: args.text }]);
}

/**
 * Move the mouse onto an element found earlier (point p from the page library), then check, at
 * that very point and without scrolling, that the same element is still there, on top, where it
 * was: hover effects can open a menu over it or move it. Returns {} (press at p, without moving
 * again), or { dialog } if the move opened a JS dialog. Throws if something changed.
 */
async function moveAndRecheck(s, p, what, modifiers = 0, verb = 'click') {
  const moved = await s.raceDialog(s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, modifiers, button: 'none' }));
  if (moved.dialog) return { dialog: moved.dialog };
  const { why } = await s.lib('pressCheck', [{ ref: p.ref, doc: p.doc, x: p.x, y: p.y, desc: p.desc }]);
  if (why) throw new ToolError('no_element', `Did not ${verb} ${what}: ${why} when the mouse went over it. Take a screenshot and check before trying again.`);
  return {};
}

/** Refuse to press when something else is on top of the element at its point. */
function refuseCovered(p) {
  if (p.covered) {
    throw new ToolError('no_element', `Did not click: ${p.covered} is on top of ${p.desc} at that point, so it would get the click. `
      + 'Close or move what covers it first, or pass the ref if you do mean to click there.');
  }
}

/** Record tabs created while an action runs (target=_blank links, window.open). */
function watchNewTabs(tabId) {
  const created = [];
  const fn = (t) => { created.push(t); };
  chrome.tabs.onCreated.addListener(fn);
  return { tabId, created, stop: () => chrome.tabs.onCreated.removeListener(fn) };
}

/** Tabs this tab opened: matched by CDP Page.windowOpen (Chrome's openerTabId is not reliable). */
async function openedTabs(w, newTabs) {
  if (!w.st.windowOpens.length && !newTabs.created.some((t) => t.openerTabId === newTabs.tabId)) return [];
  for (let i = 0; i < 10 && newTabs.created.length < w.st.windowOpens.length; i++) await new Promise((r) => setTimeout(r, 100));
  const out = [];
  for (const c of newTabs.created) {
    let t;
    try { t = await chrome.tabs.get(c.id); } catch { continue; }
    const url = t.pendingUrl || t.url || '';
    if (c.openerTabId === newTabs.tabId || w.st.windowOpens.some((u) => u === url || u === c.pendingUrl)) out.push(t);
  }
  return out;
}

/**
 * After an action: wait briefly for a navigation to start; if one does, wait for it to load.
 * Returns a sentence about what happened ('' if nothing). quiet: say only where (origin and
 * path) and what kind of dialog, no title, query or dialog text (upload_file: the page has the
 * files by then and could put them there).
 */
export async function settle(s, w, tabId, beforeUrl, { startMs = 400, loadMs = 10000, newTabs = null, quiet = false } = {}) {
  const started = await w.until((st) => st.requested || st.sameDoc || st.committed, startMs);
  let loading = false;
  if (started && !w.st.sameDoc) loading = !(await w.until((st) => st.loaded || st.stopped || st.sameDoc, loadMs));
  if (w.st.committed) s.resetWorld();
  const notes = [];
  const t = await tabSummary(tabId);
  if (t.url !== beforeUrl || w.st.committed) {
    const status = w.st.status ? ` (HTTP ${w.st.status})` : '';
    let where = t.url;
    if (quiet) { try { const u = new URL(t.url); where = u.origin + u.pathname; } catch { where = 'another page'; } }
    notes.push(loading
      ? `The page is navigating to ${where} (still loading after ${loadMs / 1000} s).`
      : `The page ${w.st.committed ? 'navigated' : 'changed its URL'} to ${where}${status}${quiet ? '' : `: ${q(t.title || '(no title)', 100)}`}.`);
  }
  if (newTabs) {
    for (const nt of await openedTabs(w, newTabs)) {
      const shared = await isShared(nt);
      notes.push(`It opened a new tab ${nt.id} (${nt.pendingUrl || nt.url || 'loading'})${shared ? ', which is in the cctether group' : '; that tab is not shared with cctether, so to use it, open its URL with open_tab'}.`);
    }
    newTabs.stop();
  }
  if (s.dialog) notes.push(dialogError(tabId, quiet ? { ...s.dialog, message: '' } : s.dialog).message);
  return notes.join(' ');
}

function dialogNote(_tabId, d) {
  return `It opened ${describeDialog(d)}. ${dialogHint(d)}`;
}

// ---- click / hover -----------------------------------------------------------------------------

export async function click({ tab, s }, args) {
  const p = await targetPoint(s, tab.id, args);
  // Found by its text, or in a frame (where a point is worked out through the frame), the element
  // must also be what gets the click: refuse rather than click whatever covers it, also after the
  // mouse moved onto it. Otherwise (ref or selector in the page) the click goes ahead and the
  // result says what got it.
  const strict = args.text != null || p.framed === true;
  const modifiers = modifierBits(args.modifiers);
  if (strict) refuseCovered(p);
  const button = args.button ?? 'left';
  const clickCount = args.click_count ?? 1;
  const before = (await tabSummary(tab.id)).url;
  const w = s.navWatch();
  const newTabs = watchNewTabs(tab.id);
  try {
    if (strict) {
      // The last check comes after the bookkeeping above: nothing between it and the press.
      const m = await moveAndRecheck(s, p, p.desc, modifiers);
      if (m.dialog) return { content: [text(`Moved the mouse onto ${p.desc}. ${dialogNote(tab.id, m.dialog)}`)] };
    }
    const r = await s.raceDialog(mouseClick(s, p.x, p.y, { button, clickCount, modifiers, move: !strict }));
    const how = [
      clickCount === 2 ? 'Double-clicked' : clickCount === 3 ? 'Triple-clicked' : button === 'right' ? 'Right-clicked' : button === 'middle' ? 'Middle-clicked' : 'Clicked',
    ];
    if (clickCount > 1 && button !== 'left') how.push(`(${button} button)`);
    const mods = args.modifiers?.length ? ` with ${args.modifiers.join('+')}` : '';
    const lines = [p.point
      ? `${how.join(' ')} at (${r0(p.x)}, ${r0(p.y)})${p.from}${mods}, on ${p.desc}.`
      : `${how.join(' ')} ${p.desc} at (${r0(p.x)}, ${r0(p.y)})${mods}.`];
    if (p.covered) lines.push(`Note: ${p.covered} was on top of it at that point, so that element got the click.`);
    if (r.dialog) {
      newTabs.stop();
      lines.push(dialogNote(tab.id, r.dialog));
    } else {
      const note = await settle(s, w, tab.id, before, { newTabs });
      if (note) lines.push(note);
    }
    return { content: [text(lines.join(' '))] };
  } finally {
    w.stop();
    newTabs.stop();
  }
}

export async function hover({ tab, s }, args) {
  const p = await targetPoint(s, tab.id, args);
  const r = await s.raceDialog(s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', modifiers: 0 }));
  const lines = [p.point ? `Moved the mouse to (${r0(p.x)}, ${r0(p.y)})${p.from}, over ${p.desc}.` : `Moved the mouse over ${p.desc} at (${r0(p.x)}, ${r0(p.y)}).`];
  if (p.covered) lines.push(`Note: ${p.covered} is on top of it at that point.`);
  if (r.dialog) lines.push(dialogNote(s.tabId, r.dialog));
  return { content: [text(lines.join(' '))] };
}

// ---- drag ---------------------------------------------------------------------------------------
//
// Real mouse events: press on `from`, move in steps, release on `to`. Chrome turns them into HTML
// drag and drop by itself when the page starts one (SPEC §11 第 16 条), so there is one way to
// drag; the page library only notes what the page did, for the result.

const DRAG_STEP_MS = 16;
const DRAG_BUDGET_MS = 20000; // the service waits 30 s (plus hold_ms) for the result
const DRAG_CLEANUP_MS = 6000; // after DRAG_BUDGET_MS: for the commands still out, and letting go
const isEl = (o) => o.ref != null || o.selector != null || o.text != null;
const elTarget = (o) => ({ ref: o.ref, selector: o.selector, text: o.text });

/** A point end of drag: x, y in the viewport, or on `screenshot`. */
async function dragPoint(s, tabId, o, screenshot) {
  const p = await pointArg(s, tabId, { x: o.x, y: o.y, screenshot });
  const r = await s.lib('at', [{ x: p.x, y: p.y }]);
  return { x: p.x, y: p.y, desc: r.desc, from: p.from };
}

export async function drag({ tab, s, startedAt = Date.now() }, args) {
  const { from, to } = args;
  const steps = args.steps ?? 10;
  const modifiers = modifierBits(args.modifiers);
  if (args.screenshot != null && s.shots.get(args.screenshot)?.kind === 'page') {
    throw bad(`Screenshot ${args.screenshot} is a full-page one: drag needs both ends in the viewport. Take a viewport screenshot (no full_page) and use its number.`);
  }
  // The extension's own deadlines come before the service gives up waiting (server/src/tools.js):
  // no new input after `deadline`; every command, letting go of the button too, ends by `hard`.
  const deadline = startedAt + DRAG_BUDGET_MS + (args.hold_ms ?? 0);
  const hard = deadline + DRAG_CLEANUP_MS;
  const left = () => Math.max(1, Math.min(10000, hard - Date.now()));
  const before = (await tabSummary(tab.id)).url;
  const w = s.navWatch();
  const newTabs = watchNewTabs(tab.id);
  // A dialog seen during the drag stays seen, even if handle_dialog closes it meanwhile.
  let dialog = s.dialog;
  const offDialog = s.on((m) => { if (m === 'Page.javascriptDialogOpening') dialog ??= s.dialog; });
  /** Wait until no check of the tab's sharing is pending (a new one may start while waiting). */
  const scopeSettled = async () => { while (s.scopeCheck) await s.scopeCheck; };
  /** Why no more input may be sent now (null: it may). Call right after scopeSettled(). */
  const blockedNow = () => {
    if (s.closed) return 'cctether no longer has the tab (it left the cctether group, or was paused or closed)';
    if (dialog) return `${describeDialog(dialog)} opened`;
    if (w.st.committed) return 'the page navigated';
    return null;
  };
  const blocked = async () => { await scopeSettled(); return blockedNow(); };
  const late = () => (Date.now() > deadline ? `it took longer than ${Math.round((DRAG_BUDGET_MS + (args.hold_ms ?? 0)) / 1000)} s` : null);
  const halt = async () => (await blocked()) ?? late();
  const input = async (params) => {
    const r = await s.raceDialog(s.send('Input.dispatchMouseEvent', { modifiers, ...params }, { timeoutMs: left() }));
    if (r.dialog) dialog ??= r.dialog;
    return r;
  };
  const pause = (ms) => Promise.race([sleep(ms), s.dialogSignal]); // a dialog cuts it short
  // What to do about the dialog: handle it, if it is still open.
  const dialogNext = () => (s.dialog ? dialogHint(s.dialog) : 'It has been closed since.');
  let pressed = false;
  let released = 'no'; // 'sent' once the release went out, 'yes' once it was answered
  let at = null; // where the mouse is, once pressed
  let done = 0; // steps made
  let stop = null; // why the drag stopped early
  try {
    // Elements first, as they may scroll into view; then points, which refuse if the page scrolled
    // since their screenshot. `to` is measured again, without scrolling, once `from` is in place.
    const toEl = isEl(to) ? await s.lib('point', [elTarget(to)]) : null;
    const a = isEl(from) ? await s.lib('point', [elTarget(from)]) : await dragPoint(s, tab.id, from, args.screenshot);
    // Pressing starts something on whatever is there: never on something covering the element.
    if (a.covered) {
      throw new ToolError('no_element', `Did not drag: ${a.covered} is on top of ${a.desc} at that point, so it would get the press. Close or move what covers it first.`);
    }
    const measureTo = async () => {
      if (toEl) {
        return s.lib('pointNow', [{ ref: toEl.ref, doc: toEl.doc }]).catch((e) => {
          if (e.code === 'no_element') throw new ToolError('no_element', `${e.message} drag needs both ends in view at once: scroll so that both are visible (or make the viewport bigger with resize_viewport), then try again.`);
          throw e;
        });
      }
      if (to.dx != null) {
        const x = a.x + to.dx;
        const y = a.y + to.dy;
        const r = await s.lib('at', [{ x, y }]);
        return { x, y, desc: r.desc, from: '' };
      }
      return dragPoint(s, tab.id, to, args.screenshot);
    };
    let b = await measureTo();
    if (Math.hypot(b.x - a.x, b.y - a.y) < 2) throw bad('`from` and `to` are the same point: nothing to drag.');

    return await whilePainting(s, tab.id, async () => {
      await s.lib('dragWatch');
      let why = await halt();
      if (!why) {
        await input({ type: 'mouseMoved', x: a.x, y: a.y, button: 'none' });
        why = await halt();
      }
      // Hovering may have changed the page: `to` as it is now, then `from` must still be the one on
      // top, unchanged and where it was (a screenshot point: the page didn't scroll). Done after any
      // pending check of the tab's sharing, and again if another one started meanwhile.
      while (!why) {
        await scopeSettled();
        const gen = s.scopeGen;
        b = await measureTo();
        if (a.ref != null) {
          const r = await s.lib('pressCheck', [{ ref: a.ref, doc: a.doc, x: a.x, y: a.y, desc: a.desc }]);
          if (r.why) throw new ToolError('no_element', `Did not drag ${a.desc}: ${r.why} when the mouse went over it. Take a screenshot and check before trying again.`);
        } else if (args.screenshot != null && from.x != null) {
          await pointArg(s, tab.id, { x: from.x, y: from.y, screenshot: args.screenshot }); // refuses if the page scrolled
        }
        if (s.scopeCheck || s.scopeGen !== gen) continue; // a check ran meanwhile: again
        why = blockedNow() ?? late();
        break;
      }
      if (why) {
        const lines = [`Did not drag ${a.desc}: ${why} before the button was pressed.`];
        if (dialog) lines.push(dialogNext());
        return { content: [text(lines.join(' '))] };
      }
      pressed = true;
      at = a;
      await input({ type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 });
      if (args.hold_ms) await pause(args.hold_ms);
      for (let i = 1; i <= steps; i++) {
        stop = await halt();
        if (stop) break;
        const p = { x: a.x + (b.x - a.x) * (i / steps), y: a.y + (b.y - a.y) * (i / steps) };
        await input({ type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 });
        at = p;
        done = i;
        await pause(DRAG_STEP_MS);
      }
      stop ??= await halt();
      if (!stop) {
        released = 'sent';
        const r = await input({ type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 });
        if (r.dialog) stop = `${describeDialog(dialog)} opened as it was released`;
        else released = 'yes';
      }
      await pause(50); // drop and mouseup handlers
      // What follows only adds to the result: skipped when the time is nearly up.
      const room = () => hard - Date.now();
      const live = !s.closed && !w.st.committed && !s.dialog && room() > 1500;
      const seen = live ? await s.lib('dragResult', [], { timeoutMs: Math.min(2000, room() - 1000) }).catch(() => null) : null;
      const mods = args.modifiers?.length ? ` with ${args.modifiers.join('+')} held` : '';
      const where = (p) => `(${r0(p.x)}, ${r0(p.y)})`;
      const lines = [];
      if (released === 'no') {
        lines.push(`Started dragging ${a.desc} from ${where(a)}${a.from ?? ''} towards ${where(b)}${mods}, but stopped after ${done} of ${steps} steps, at ${where(at)}: ${stop}.`);
        lines.push(`The mouse button was not released (no more input was sent to the page).${dialog ? ` ${dialogNext()}` : ''} Check the page with a screenshot.`);
      } else {
        lines.push(`Dragged ${a.desc} from ${where(a)}${a.from ?? ''} to ${where(b)}${b.from ?? ''}${mods}, in ${steps} step${steps === 1 ? '' : 's'}. Before the drag, ${b.desc} was at the end point.`);
        if (released === 'sent') lines.push(`The button release was sent, but ${stop}. ${dialogNext()} Then check the page.`);
      }
      // Only a drag that ended says anything for sure (a cancelled dragstart doesn't start one).
      if (seen?.start && seen.ended) {
        const effect = seen.effect === 'none' ? 'drop effect "none": nothing accepted the drop' : `drop effect ${JSON.stringify(seen.effect)}`;
        lines.push(`The page handled it as HTML drag and drop: dragstart on ${seen.start}, ${seen.drop ? `drop on ${seen.drop}` : 'no drop event seen'}, ${effect}.`);
      }
      if (!s.closed && room() > 1500) {
        // Raced with the time left: the drag's own outcome is what must come back in time.
        const left = room() - 1000;
        const note = await Promise.race([
          settle(s, w, tab.id, before, { newTabs, startMs: Math.min(400, left), loadMs: Math.min(10000, left) }).catch(() => ''),
          sleep(left).then(() => ''),
        ]);
        if (note) lines.push(note);
      }
      if (released === 'yes') lines.push('Check the result with a screenshot or read_page.');
      return { content: [text(lines.join(' '))] };
    });
  } catch (e) {
    // Something failed in the middle: if nothing stands in the way and there is time, end the
    // page's drag (an HTML one is cancelled, so the release doesn't drop it) and let go of the
    // button where the mouse is. Say exactly how far that got.
    if (pressed && e instanceof Error) {
      let note;
      const tooLate = () => hard - Date.now() < 1000;
      if (released === 'sent') {
        note = 'the button release was sent, but its answer did not come, so it may or may not have taken effect';
      } else if (released === 'yes') {
        note = 'the mouse button was released';
      } else if (await blocked() || tooLate()) {
        note = 'the mouse button was not released (no more input was sent to the page)';
      } else if (!(await s.send('Input.cancelDragging', {}, { timeoutMs: left() }).then(() => true, () => false)) || await blocked() || tooLate()) {
        note = 'the mouse button was not released (the drag could not be cancelled first)';
      } else {
        const ok = await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, modifiers, button: 'left', buttons: 0, clickCount: 1 }, { timeoutMs: left() })
          .then(() => true, () => false);
        note = ok ? `any HTML drag was cancelled and the mouse button released at (${r0(at.x)}, ${r0(at.y)})` : 'releasing the mouse button failed or was not answered: it may still be held';
      }
      e.message = `${e.message} (The drag stopped after ${done} of ${steps} steps; ${note}. Check the page.)`;
    }
    throw e;
  } finally {
    offDialog();
    w.stop();
    newTabs.stop();
    // Stop watching (already done unless something failed), if there is time.
    if (!w.st.committed && !s.dialog && !s.closed && hard - Date.now() > 1500) await s.lib('dragResult', [], { timeoutMs: 1000 }).catch(() => {});
  }
}

// ---- keyboard ----------------------------------------------------------------------------------

const MOD_ALIASES = {
  alt: 'Alt', option: 'Alt', opt: 'Alt',
  ctrl: 'Control', control: 'Control',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta', windows: 'Meta',
  shift: 'Shift',
};
const MOD_DEFS = {
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
};

const k = (key, code, keyCode, txt) => ({ key, code, keyCode, ...(txt ? { text: txt } : {}) });
const NAMED = {
  enter: k('Enter', 'Enter', 13, '\r'), return: k('Enter', 'Enter', 13, '\r'),
  tab: k('Tab', 'Tab', 9),
  escape: k('Escape', 'Escape', 27), esc: k('Escape', 'Escape', 27),
  backspace: k('Backspace', 'Backspace', 8),
  delete: k('Delete', 'Delete', 46), del: k('Delete', 'Delete', 46),
  insert: k('Insert', 'Insert', 45),
  arrowup: k('ArrowUp', 'ArrowUp', 38), up: k('ArrowUp', 'ArrowUp', 38),
  arrowdown: k('ArrowDown', 'ArrowDown', 40), down: k('ArrowDown', 'ArrowDown', 40),
  arrowleft: k('ArrowLeft', 'ArrowLeft', 37), left: k('ArrowLeft', 'ArrowLeft', 37),
  arrowright: k('ArrowRight', 'ArrowRight', 39), right: k('ArrowRight', 'ArrowRight', 39),
  home: k('Home', 'Home', 36), end: k('End', 'End', 35),
  pageup: k('PageUp', 'PageUp', 33), pgup: k('PageUp', 'PageUp', 33),
  pagedown: k('PageDown', 'PageDown', 34), pgdn: k('PageDown', 'PageDown', 34),
  space: k(' ', 'Space', 32, ' '), spacebar: k(' ', 'Space', 32, ' '),
  capslock: k('CapsLock', 'CapsLock', 20), contextmenu: k('ContextMenu', 'ContextMenu', 93),
  numlock: k('NumLock', 'NumLock', 144), scrolllock: k('ScrollLock', 'ScrollLock', 145),
  pause: k('Pause', 'Pause', 19), printscreen: k('PrintScreen', 'PrintScreen', 44),
  plus: k('+', 'Equal', 187, '+'),
};
for (let i = 1; i <= 24; i++) NAMED[`f${i}`] = k(`F${i}`, `F${i}`, 111 + i);

const PUNCT = {
  '`': ['Backquote', 192, '~'], '-': ['Minus', 189, '_'], '=': ['Equal', 187, '+'], '[': ['BracketLeft', 219, '{'],
  ']': ['BracketRight', 221, '}'], '\\': ['Backslash', 220, '|'], ';': ['Semicolon', 186, ':'], "'": ['Quote', 222, '"'],
  ',': ['Comma', 188, '<'], '.': ['Period', 190, '>'], '/': ['Slash', 191, '?'],
};
const DIGIT_SHIFTED = ')!@#$%^&*(';

function charDef(ch, shift) {
  if (/^[a-z]$/i.test(ch)) {
    const up = ch.toUpperCase();
    const t = shift || ch === up ? up : ch.toLowerCase();
    return k(t, `Key${up}`, up.charCodeAt(0), t);
  }
  if (/^\d$/.test(ch)) {
    const t = shift ? DIGIT_SHIFTED[Number(ch)] : ch;
    return k(t, `Digit${ch}`, 48 + Number(ch), t);
  }
  if (PUNCT[ch]) {
    const [code, kc, sh] = PUNCT[ch];
    const t = shift ? sh : ch;
    return k(t, code, kc, t);
  }
  for (const [code, kc, sh] of Object.values(PUNCT)) if (sh === ch) return k(ch, code, kc, ch);
  const d = DIGIT_SHIFTED.indexOf(ch);
  if (d >= 0) return k(ch, `Digit${d}`, 48 + d, ch);
  return { key: ch, code: '', keyCode: 0, text: ch };
}

/** "Control+Shift+K" → { bits, def, label } */
export function parseKey(spec) {
  const raw = String(spec);
  if (!raw.trim() && raw !== ' ') throw bad('`key` is empty.');
  let parts;
  if (raw === '+') parts = ['+'];
  else if (raw.endsWith('++')) parts = [...raw.slice(0, -2).split('+'), '+'];
  else parts = raw.split('+');
  const main = parts.pop();
  let bits = 0;
  for (const p of parts) {
    const m = MOD_ALIASES[p.trim().toLowerCase()];
    if (!m) throw bad(`Unknown modifier ${q(p)} in ${q(raw)}. Use Control, Shift, Alt or Meta (Cmd on a Mac).`);
    bits |= MOD_BITS[m];
  }
  const lower = main.trim().toLowerCase();
  let def;
  if (MOD_ALIASES[lower]) {
    const m = MOD_ALIASES[lower];
    def = MOD_DEFS[m];
    bits &= ~MOD_BITS[m];
    return { bits, def, modifierOnly: m };
  }
  if (main === ' ') def = NAMED.space;
  else if (NAMED[lower]) def = NAMED[lower];
  else if ([...main].length === 1) {
    // With Control/Alt/Meta, "Control+A" means the A key: a lowercase letter unless Shift is held.
    const ch = bits & ~MOD_BITS.Shift ? main.toLowerCase() : main;
    def = charDef(ch, (bits & MOD_BITS.Shift) !== 0);
  }
  else throw bad(`Unknown key ${q(main)}. Examples: Enter, Tab, Escape, Backspace, ArrowDown, PageDown, F5, a, Control+A, Shift+Tab, Meta+Shift+P.`);
  return { bits, def };
}

// Editing shortcuts that macOS handles in the browser UI layer, so synthetic key events need an
// explicit editing command (CDP Input.dispatchKeyEvent `commands`).
export const MAC_COMMANDS = {
  'Meta+KeyA': ['selectAll'], 'Meta+KeyC': ['copy'], 'Meta+KeyX': ['cut'], 'Meta+KeyV': ['paste'],
  'Meta+KeyZ': ['undo'], 'Meta+Shift+KeyZ': ['redo'],
  'Meta+ArrowLeft': ['moveToBeginningOfLine'], 'Meta+ArrowRight': ['moveToEndOfLine'],
  'Meta+ArrowUp': ['moveToBeginningOfDocument'], 'Meta+ArrowDown': ['moveToEndOfDocument'],
  'Meta+Shift+ArrowLeft': ['moveToBeginningOfLineAndModifySelection'], 'Meta+Shift+ArrowRight': ['moveToEndOfLineAndModifySelection'],
  'Meta+Shift+ArrowUp': ['moveToBeginningOfDocumentAndModifySelection'], 'Meta+Shift+ArrowDown': ['moveToEndOfDocumentAndModifySelection'],
  'Alt+ArrowLeft': ['moveWordLeft'], 'Alt+ArrowRight': ['moveWordRight'],
  'Alt+Backspace': ['deleteWordBackward'], 'Meta+Backspace': ['deleteToBeginningOfLine'],
};

const comboName = (bits, def) => [bits & MOD_BITS.Control && 'Control', bits & MOD_BITS.Meta && 'Meta', bits & MOD_BITS.Alt && 'Alt', bits & MOD_BITS.Shift && 'Shift', def.code]
  .filter(Boolean).join('+');

function macCommands(bits, def) {
  return MAC_COMMANDS[comboName(bits, def)];
}

// Windows and Linux habits that do nothing useful on a Mac. Claude Code often runs on Linux while the
// browser is on a Mac, and on a real test Control+A just silently didn't select anything.
const MAC_INSTEAD = {
  'Control+KeyA': 'Meta+A', 'Control+KeyC': 'Meta+C', 'Control+KeyX': 'Meta+X', 'Control+KeyV': 'Meta+V',
  'Control+KeyZ': 'Meta+Z', 'Control+Shift+KeyZ': 'Meta+Shift+Z', 'Control+KeyY': 'Meta+Shift+Z',
  'Control+ArrowLeft': 'Alt+ArrowLeft', 'Control+ArrowRight': 'Alt+ArrowRight', 'Control+Backspace': 'Alt+Backspace',
};

/** On a Mac: the sentence to add when `pressed` looks like a shortcut from another system, else null. */
export function macHint({ bits, def, modifierOnly }, pressed) {
  const instead = modifierOnly ? null : MAC_INSTEAD[comboName(bits, def)];
  return instead ? `This browser is on macOS, where ${pressed} isn't an editing shortcut. Did you mean ${instead}?` : null;
}

function keyEvent(s, type, def, modifiers, { txt, commands } = {}) {
  const p = {
    type, key: def.key, windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode,
    modifiers, location: def.location ?? 0, autoRepeat: false, isKeypad: false,
  };
  if (def.code) p.code = def.code;
  if (txt) { p.text = txt; p.unmodifiedText = txt; }
  if (commands) p.commands = commands;
  return s.send('Input.dispatchKeyEvent', p);
}

export async function pressCombo(s, { bits, def }, mac = isMac()) {
  let cur = 0;
  const held = [];
  for (const m of ['Control', 'Alt', 'Meta', 'Shift']) {
    if (bits & MOD_BITS[m]) {
      cur |= MOD_BITS[m];
      held.push(m);
      await keyEvent(s, 'rawKeyDown', MOD_DEFS[m], cur);
    }
  }
  // With Control/Alt/Meta held the key produces no character (only Shift changes the text).
  const txt = bits & ~MOD_BITS.Shift ? '' : (def.text ?? '');
  const commands = mac ? macCommands(bits, def) : undefined;
  await keyEvent(s, txt ? 'keyDown' : 'rawKeyDown', def, bits, { txt, commands });
  await keyEvent(s, 'keyUp', def, bits);
  for (const m of held.reverse()) {
    cur &= ~MOD_BITS[m];
    await keyEvent(s, 'keyUp', MOD_DEFS[m], cur);
  }
}

export async function pressKey({ tab, s }, args) {
  const combo = parseKey(args.key);
  const repeat = args.repeat ?? 1;
  const before = (await tabSummary(tab.id)).url;
  const w = s.navWatch();
  try {
    for (let i = 0; i < repeat; i++) {
      const r = await s.raceDialog(combo.modifierOnly
        ? keyEvent(s, 'rawKeyDown', combo.def, combo.bits | MOD_BITS[combo.modifierOnly]).then(() => keyEvent(s, 'keyUp', combo.def, combo.bits))
        : pressCombo(s, combo));
      if (r.dialog) {
        return { content: [text(`Pressed ${args.key}${i ? ` ${i + 1} times` : ''}. ${dialogNote(tab.id, r.dialog)}`)] };
      }
    }
    const lines = [`Pressed ${args.key}${repeat > 1 ? ` ${repeat} times` : ''}.`];
    const note = await settle(s, w, tab.id, before, { startMs: 250 });
    if (note) lines.push(note);
    else {
      try {
        const a = await s.lib('active', [], { timeoutMs: 2000 });
        lines.push(a.none ? 'Nothing is focused now.' : `Focus is on ${a.desc}.`);
      } catch { /* page busy: skip */ }
    }
    const hint = isMac() ? macHint(combo, args.key) : null;
    if (hint) lines.push(hint);
    return { content: [text(lines.join(' '))] };
  } finally {
    w.stop();
  }
}

// ---- type --------------------------------------------------------------------------------------

export async function type({ tab, s }, args) {
  if (args.ref != null && args.selector != null) throw bad('Pass `ref` or `selector`, not both.');
  const target = { ref: args.ref, selector: args.selector };
  const hasTarget = args.ref != null || args.selector != null;
  // Typing is pinned to one element (SPEC §5.2): the one that got the focus for the target, or
  // the focused one. Before each step the focus must still be on it.
  let a;
  // With a target, the focus must be somewhere cctether can see (SPEC §5.2): typing into a frame
  // it can't look into is only done blind, without a target, clear or submit.
  const blindTarget = (desc) => new ToolError('no_element', `The focus went into a frame cctether can't see into (another site's, or sandboxed) when it focused ${desc}, so it can't check where the text would go. Click the field inside it (e.g. at a point of a screenshot), then call type without ref or selector (and without clear or submit).`);
  if (hasTarget) {
    const f = await s.lib('focus', [target]);
    if (f.focused) {
      if (f.blind) throw blindTarget(f.desc);
      a = { desc: f.desc, editable: f.editable, ref: f.ref, doc: f.doc, blind: false };
    } else {
      // Not focusable by script (e.g. a wrapper element): click it like a user would, but only
      // if it is what gets the click, and only accept the focus if it went to it. The element
      // focus() found, by its number: the selector is not looked up again.
      const p = await s.lib('point', [{ ref: f.target, doc: f.doc }]);
      if (p.covered) throw new ToolError('no_element', `Did not click ${p.desc} to focus it: ${p.covered} is on top of it at that point, so it would get the click. Close or move what covers it first.`);
      const m = await moveAndRecheck(s, p, `${p.desc} (to focus it)`);
      if (m.dialog) return { content: [text(`Moved the mouse onto ${p.desc} to focus it. ${dialogNote(tab.id, m.dialog)}`)] };
      const r = await s.raceDialog(mouseClick(s, p.x, p.y, { move: false }));
      if (r.dialog) return { content: [text(`Clicked ${p.desc} to focus it. ${dialogNote(tab.id, r.dialog)}`)] };
      const on = await s.lib('focusedOn', [{ ref: p.ref, doc: p.doc }]);
      if (!on.ok) {
        throw new ToolError('no_element', `${f.desc} could not be focused: clicking it put the focus on ${on.now}, so cctether typed nothing. Pick an input, textarea or editable element.`);
      }
      if (on.none) throw new ToolError('no_element', `${f.desc} could not be focused (clicking it did not focus anything), so there is nowhere to type. Pick an input, textarea or editable element.`);
      if (on.blind) throw blindTarget(f.desc);
      a = on;
    }
  } else {
    a = await s.lib('active');
    if (a.none) throw new ToolError('no_element', 'No element is focused. Pass `ref` or `selector` to say where to type.');
  }
  const pin = { ref: a.ref, doc: a.doc };
  const desc = a.desc;
  if (a.blind && (args.clear || args.submit)) {
    throw new ToolError('no_element', `The focus is in ${desc}, a frame cctether can't see into (another site's, or sandboxed), so it can't check what clear or submit would act on. Type without clear and submit (press_key can press Enter).`);
  }
  let cleared = false;
  if (args.clear) {
    const sel = await s.lib('selectAllInFocused', [{ pin, when: 'before clearing' }]);
    if (sel.len > 0) {
      await s.lib('checkFocus', [{ pin, when: 'before clearing' }]);
      const r = await s.raceDialog(pressCombo(s, parseKey('Backspace')));
      if (r.dialog) return { content: [text(`Cleared ${desc}. ${dialogNote(tab.id, r.dialog)}`)] };
      if ((await s.lib('focusedLength', [{ pin, when: 'while clearing' }])) > 0) await s.lib('forceClear', [{ pin, when: 'while clearing' }]);
    }
    cleared = true;
  }
  if (args.text.length) {
    await s.lib('checkFocus', [{ pin, when: cleared ? 'after clearing, before typing' : 'before typing' }]);
    const r = await s.raceDialog(s.send('Input.insertText', { text: args.text }, { timeoutMs: 20000 }));
    if (r.dialog) return { content: [text(`Typed into ${desc}. ${dialogNote(tab.id, r.dialog)}`)] };
  }
  const n = [...args.text].length;
  const lines = [`Typed ${n} character${n === 1 ? '' : 's'} into ${desc}${cleared ? ' (after clearing it)' : ''}.`];
  if (a.blind) lines.push("It is inside a frame cctether can't see into, so it can't check where the text went or what the field shows now; take a screenshot.");
  else if (!a.editable) lines.push('Note: it is not a text field, so the text may not have gone anywhere; check with read_page.');
  if (!args.submit) {
    if (!a.blind) {
      try {
        const v = await s.lib('valueOf', [{ pin }], { timeoutMs: 3000 });
        if (v.value != null && !v.password) lines.push(`Its value is now ${q(v.value, 200)}.`);
      } catch { /* ignore */ }
    }
  } else {
    const before = (await tabSummary(tab.id)).url;
    const w = s.navWatch();
    try {
      // Right before the key: nothing between this check and Enter.
      await s.lib('checkFocus', [{ pin, when: 'before pressing Enter (the text was typed)' }]);
      const r = await s.raceDialog(pressCombo(s, parseKey('Enter')));
      if (r.dialog) {
        lines.push(`Pressed Enter. ${dialogNote(tab.id, r.dialog)}`);
      } else {
        lines.push('Pressed Enter.');
        const note = await settle(s, w, tab.id, before, { startMs: 500 });
        if (note) lines.push(note);
      }
    } finally {
      w.stop();
    }
  }
  return { content: [text(lines.join(' '))] };
}

// ---- scroll ------------------------------------------------------------------------------------

function scrollSummary(st) {
  const p = st.page;
  return `Page scroll position: x=${p.x}, y=${p.y} (max x=${p.maxX}, max y=${p.maxY}; viewport ${p.vw}×${p.vh}).`;
}

/** The first area of the chain (innermost first) whose position differs, or null. */
const movedArea = (a, b) => a.chain.find((c, i) => b.chain[i] && (c.top !== b.chain[i].top || c.left !== b.chain[i].left)) ?? null;
const sameScroll = (a, b) => a.page.x === b.page.x && a.page.y === b.page.y && !movedArea(a, b);

export async function scroll({ tab, s }, args) {
  const hasEl = args.ref != null || args.selector != null || args.text != null;
  checkElementArgs(args);
  if (hasEl && (args.x != null || args.y != null || args.screenshot != null)) throw bad('Pass either an element (`ref`, `selector`, `text`) or a point (`x`, `y`), not both.');
  if (hasEl && args.direction == null) {
    const r = await s.lib('scrollTo', [{ ref: args.ref, selector: args.selector, text: args.text }]);
    const st = await s.lib('scrollState', [{}]);
    return { content: [text(`Scrolled ${r.desc} into view; its centre is now at (${r.x}, ${r.y}). ${scrollSummary(st)}`)] };
  }
  const dir = args.direction ?? 'down';
  let x;
  let y;
  if (hasEl) {
    const p = await s.lib('point', [{ ref: args.ref, selector: args.selector, text: args.text }]);
    ({ x, y } = p);
  } else if (args.x != null || args.y != null || args.screenshot != null) {
    ({ x, y } = await pointArg(s, tab.id, args));
    await s.lib('at', [{ x, y }]); // validates the point
  } else {
    const m = await s.lib('metrics');
    x = Math.floor(m.vw / 2);
    y = Math.floor(m.vh / 2);
  }
  // The scrolling areas at that point, found once: afterwards the same areas are read again (the
  // content under the point moves, so asking the point again could name other areas).
  const before = await s.lib('scrollState', [{ x, y }]);
  const again = { chain: before.chain.map((c) => c.ref), doc: before.doc };
  const vertical = dir === 'up' || dir === 'down';
  const amount = args.amount ?? Math.max(1, Math.round((vertical ? before.page.vh : before.page.vw) * 0.8));
  const dx = vertical ? 0 : dir === 'left' ? -amount : amount;
  const dy = vertical ? (dir === 'up' ? -amount : amount) : 0;
  await s.guardDialog(s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, modifiers: 0 }));
  // Wheel scrolling may be animated: wait until the position stops changing.
  let after = before;
  let stableSince = Date.now();
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1500) {
    await new Promise((r) => setTimeout(r, 60));
    const now = await s.lib('scrollState', [again]);
    if (now.lost) { after = now; break; }
    if (!sameScroll(now, after)) { after = now; stableSince = Date.now(); }
    if (Date.now() - stableSince > (sameScroll(after, before) ? 300 : 150)) break;
  }
  // Nothing moved: scroll with script instead (not if an area is gone: what to move is unclear).
  if (!after.lost && sameScroll(after, before)) {
    if (await s.lib('scrollByJs', [{ ...again, dx, dy }])) after = await s.lib('scrollState', [again]);
  }
  const lines = [];
  const inner = after.lost ? null : movedArea(after, before);
  if (after.lost) {
    lines.push(`The scrolling area at (${r0(x)}, ${r0(y)}) changed or went away while scrolling; take a screenshot to see where things are now.`);
  } else if (sameScroll(after, before)) {
    lines.push(`Nothing scrolled ${dir}: the page${before.chain.length ? ' and the scrollable areas at that point are' : ' is'} already at the ${{ up: 'top', down: 'bottom', left: 'left edge', right: 'right edge' }[dir]}, or the area at (${r0(x)}, ${r0(y)}) can't scroll.`);
  } else if (inner) {
    lines.push(`Scrolled ${dir} inside ${inner.desc}: its scroll position is now top=${inner.top}, left=${inner.left} (max top=${inner.maxTop}, max left=${inner.maxLeft}).`);
  } else {
    const moved = vertical ? Math.abs(after.page.y - before.page.y) : Math.abs(after.page.x - before.page.x);
    lines.push(`Scrolled ${dir} ${moved} px.`);
  }
  lines.push(scrollSummary(after));
  return { content: [text(lines.join(' '))] };
}

// ---- select_option -----------------------------------------------------------------------------

export async function selectOption({ tab, s }, args) {
  if (args.ref != null && args.selector != null) throw bad('Pass `ref` or `selector`, not both.');
  if (args.ref == null && args.selector == null) throw bad('Pass `ref` or `selector` for the dropdown.');
  const values = Array.isArray(args.value) ? args.value : [args.value];
  const t = await s.lib('ddTarget', [{ ref: args.ref, selector: args.selector }]);
  if (!t.native) return customSelect(tab, s, t, values);
  // The select ddTarget found, by its number: the selector is not looked up a second time.
  const r = await s.lib('selectOption', [{ ref: t.ref, doc: t.doc, values }]);
  if (!r.matched) {
    const list = r.options.map((o) => `value=${JSON.stringify(o.value)} label=${JSON.stringify(o.label)}${o.disabled ? ' (disabled)' : ''}`).join('\n');
    throw new ToolError('not_found', `No option of ${r.desc} matches ${values.map((v) => q(v)).join(', ')} (by value or label). Options${r.total > r.options.length ? ` (first ${r.options.length} of ${r.total})` : ''}:\n${untrusted(list || '(none)')}`);
  }
  const lines = [`Selected ${r.chosen.map((c) => q(c)).join(', ') || '(nothing)'} in ${r.desc}.`];
  if (r.unmatched.length) lines.push(`Not found (by value or label): ${r.unmatched.map((v) => q(v)).join(', ')}.`);
  if (!r.multiple && values.length > 1) lines.push('It is a single-choice <select>, so only the first match was used.');
  return { content: [text(lines.join(' '))] };
}

const OPEN_WAIT_MS = 2000;
const SETTLE_MAX_MS = 1000;
const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

const optionLine = (o) => `[${o.ref}] option ${JSON.stringify(o.label)}${o.value != null && o.value !== o.label ? ` value=${JSON.stringify(o.value)}` : ''}${o.selected ? ' selected' : ''}${o.disabled ? ' disabled' : ''}`;

function optionList(options, max = 30) {
  const lines = options.slice(0, max).map(optionLine);
  if (options.length > max) lines.push(`… and ${options.length - max} more`);
  return untrusted(lines.join('\n') || '(none)');
}

/**
 * select_option on an element that declares it is a dropdown (SPEC §5.2): open it with a real
 * click if needed, find the option in the list it names (aria-controls / aria-owns) or holds, and
 * click that option with a real click. Never guesses which list belongs to it.
 */
async function customSelect(tab, s, t, values) {
  if (values.length !== 1) throw bad(`${t.desc} is a custom dropdown: pass one value per call.`);
  // A background tab draws no frames, so opening and closing animations would not move on (and
  // input is slow): keep it painting for the whole call.
  return whilePainting(s, tab.id, () => pickCustom(tab, s, t, values[0]));
}

async function pickCustom(tab, s, t, value) {
  let opened = false;
  if (!t.list && !t.expanded) {
    const p = await s.lib('point', [{ ref: t.ref, doc: t.doc }]);
    if (p.covered) throw new ToolError('no_element', `Did not open ${t.desc}: ${p.covered} is on top of it. Close what covers it first.`);
    const r = await s.raceDialog(mouseClick(s, p.x, p.y));
    if (r.dialog) return { content: [text(`Clicked ${t.desc} to open it. ${dialogNote(tab.id, r.dialog)}`)] };
    opened = true;
  }
  // The list may be rendered a moment later, and many widgets name it only once it is open.
  let list;
  const deadline = Date.now() + (opened ? OPEN_WAIT_MS : 0);
  for (;;) {
    list = await s.lib('ddOptions', [{ ref: t.ref, doc: t.doc }]);
    if (list.total || Date.now() >= deadline) break;
    await sleep(100);
  }
  const did = opened ? `Opened ${t.desc}` : `${t.desc[0].toUpperCase()}${t.desc.slice(1)} is open`;
  if (!list.total) {
    const vis = await s.lib('visibleOptions', [{ limit: 30 }]);
    const why = list.named
      ? 'the list it names (aria-controls / aria-owns) has no visible options (some widgets render options elsewhere, or only a few at a time)'
      : 'it does not say which list belongs to it (no aria-controls or aria-owns, and no options inside it)';
    throw new ToolError('not_found', `${did}, but ${why}, so cctether did not pick an option. It is left open. `
      + (vis.total
        ? `Options visible on the page now${vis.total > vis.lines.length ? ` (first ${vis.lines.length} of ${vis.total})` : ''}; click the right one with click and its ref:\n${untrusted(vis.lines.join('\n'))}`
        : 'No option-like elements are visible on the page: take a screenshot, then click the option with click and text.'));
  }
  const m = await s.lib('ddPick', [{ ref: t.ref, doc: t.doc, value }]);
  if (!m.option) {
    const more = (shown, total) => (total > shown ? `\n… and ${total - shown} more` : '');
    throw new ToolError('not_found', m.many
      ? `${m.count} options of ${t.desc} ${m.how} (${q(value)}), so cctether did not pick one; click the right one with click and its ref. ${opened ? 'It is left open. ' : ''}Matching options:\n${optionList(m.many)}${more(m.many.length, m.count)}`
      : `No option of ${t.desc} matches ${q(value)} (by value or label). ${opened ? 'It is left open. ' : ''}Options${m.total > m.options.length ? ` (first ${m.options.length} of ${m.total})` : ''}:\n${optionList(m.options)}`);
  }
  const o = m.option;
  if (o.disabled) throw new ToolError('not_found', `The option ${q(o.label)} of ${t.desc} is disabled.`);
  if (o.selected && m.multi) {
    return { content: [text(`${q(o.label)} is already selected in ${t.desc} (clicking it again would deselect it), so nothing was clicked.`)] };
  }
  // A list that is still opening (a menu growing or fading in) often ignores clicks: wait until
  // it has settled (seen on a real MUI Select: 0.17 s and 0.25 s transitions).
  for (const until = Date.now() + SETTLE_MAX_MS; ;) {
    const { left } = await s.lib('ddSettling', [{ ref: o.ref, doc: t.doc }]);
    if (!left || Date.now() >= until) break;
    await sleep(Math.min(left + 20, until - Date.now()));
  }
  // Scroll the option into view (also inside the list), move the mouse onto it, and check again
  // that it is the option that is there (hover effects can move or cover things) before pressing.
  const p2 = await s.lib('point', [{ ref: o.ref, doc: t.doc }]);
  if (p2.covered) throw new ToolError('no_element', `Did not click the option ${q(o.label)}: ${p2.covered} is on top of it.`);
  const m2 = await moveAndRecheck(s, p2, `the option ${q(o.label)}`);
  if (m2.dialog) return { content: [text(`Moved the mouse onto the option ${q(o.label)} of ${t.desc}. ${dialogNote(tab.id, m2.dialog)}`)] };
  const before = (await tabSummary(tab.id)).url; // before the last check: nothing may come between it and the press
  // Last check, in one go right before pressing: the value still picks this same option, it is
  // still not selected if selecting again would deselect it, and it is on top at that point.
  const fin = await s.lib('ddFinal', [{ ref: t.ref, doc: t.doc, value, opt: o, x: p2.x, y: p2.y }]);
  if (!fin.same) {
    throw new ToolError('no_element', `Did not click the option ${q(o.label)}: the list changed when the mouse went over it${fin.now ? ` (the value now picks ${q(fin.now.label)}${fin.now.disabled ? ', disabled' : ''})` : ''}. Take a screenshot and check before trying again.`);
  }
  if (fin.multi && fin.selected) {
    return { content: [text(`${q(o.label)} became selected in ${t.desc} when the mouse went over it (clicking it would deselect it), so nothing was clicked.`)] };
  }
  if (!fin.onTop) throw new ToolError('no_element', `Did not click the option ${q(o.label)}: ${fin.hit} is on top of it now.`);
  const w = s.navWatch();
  try {
    const r = await s.raceDialog(mouseClick(s, p2.x, p2.y, { move: false }));
    const head = `${opened ? `Opened ${t.desc} and clicked` : 'Clicked'} its option ${q(o.label)}.`;
    if (r.dialog) return { content: [text(`${head} ${dialogNote(tab.id, r.dialog)}`)] };
    const note = await settle(s, w, tab.id, before, { startMs: 150 });
    if (note) return { content: [text(`${head} ${note}`)] };
    // Read back what the dropdown shows, so a retry doesn't click again blindly; and wait for its
    // list to finish closing (a closing menu or backdrop would cover it for the next call).
    let now = null;
    const until = Date.now() + 1000;
    for (;;) {
      try { now = await s.lib('ddShown', [{ ref: t.ref, doc: t.doc }], { timeoutMs: 2000 }); } catch { now = null; }
      const done = !now || now.gone || (norm(now.shown).toLowerCase().includes(o.label.toLowerCase()) && (m.multi || (!now.expanded && !now.covered)));
      if (done || Date.now() >= until) break;
      await sleep(80);
    }
    let after;
    if (!now) after = 'Could not read what the dropdown shows now; check with a screenshot before trying again.';
    else if (now.gone) after = 'The dropdown is no longer on the page; check with a screenshot before trying again.';
    else after = `It now shows ${now.shown ? q(now.shown, 200) : 'nothing'}${now.expanded ? ' and is still open' : ''}.`;
    return { content: [text(`${head} ${after}`)] };
  } finally {
    w.stop();
  }
}

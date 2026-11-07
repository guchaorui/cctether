// Mouse and keyboard tools: click, hover, type, press_key, scroll, select_option.
// Input goes through CDP Input.* so the page sees real (trusted) events.

import { ToolError } from './errors.js';
import { q, untrusted } from './util.js';
import { isShared } from '../tabs.js';
import { dialogError, describeDialog, dialogHint } from '../debugger.js';
import { tabSummary, isMac } from './browser.js';

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

async function mouseClick(s, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers, button: 'none' });
  for (let i = 1; i <= clickCount; i++) {
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, modifiers, button, buttons: BUTTON_BITS[button], clickCount: i });
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, modifiers, button, buttons: 0, clickCount: i });
  }
}

/** Resolve ref / selector / (x, y) to a viewport point. */
async function targetPoint(s, args) {
  const hasEl = args.ref != null || args.selector != null;
  const hasXY = args.x != null || args.y != null;
  if (args.ref != null && args.selector != null) throw bad('Pass `ref` or `selector`, not both.');
  if (hasEl && hasXY) throw bad('Pass either an element (`ref` or `selector`) or a point (`x` and `y`), not both.');
  if (hasXY) {
    if (args.x == null || args.y == null) throw bad('Pass both `x` and `y`.');
    const r = await s.lib('at', [{ x: args.x, y: args.y }]);
    return { x: args.x, y: args.y, desc: r.desc, point: true, covered: null };
  }
  if (!hasEl) throw bad('Pass `ref` or `selector` (or `x` and `y`) to say where.');
  return s.lib('point', [{ ref: args.ref, selector: args.selector }]);
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
 * Returns a sentence about what happened ('' if nothing).
 */
export async function settle(s, w, tabId, beforeUrl, { startMs = 400, loadMs = 10000, newTabs = null } = {}) {
  const started = await w.until((st) => st.requested || st.sameDoc || st.committed, startMs);
  let loading = false;
  if (started && !w.st.sameDoc) loading = !(await w.until((st) => st.loaded || st.stopped || st.sameDoc, loadMs));
  if (w.st.committed) s.resetWorld();
  const notes = [];
  const t = await tabSummary(tabId);
  if (t.url !== beforeUrl || w.st.committed) {
    const status = w.st.status ? ` (HTTP ${w.st.status})` : '';
    notes.push(loading
      ? `The page is navigating to ${t.url} (still loading after ${loadMs / 1000} s).`
      : `The page ${w.st.committed ? 'navigated' : 'changed its URL'} to ${t.url}${status}: ${q(t.title || '(no title)', 100)}.`);
  }
  if (newTabs) {
    for (const nt of await openedTabs(w, newTabs)) {
      const shared = await isShared(nt);
      notes.push(`It opened a new tab ${nt.id} (${nt.pendingUrl || nt.url || 'loading'})${shared ? ', which is in the cctether group' : '; that tab is not shared with cctether, so to use it, open its URL with open_tab'}.`);
    }
    newTabs.stop();
  }
  if (s.dialog) notes.push(dialogError(tabId, s.dialog).message);
  return notes.join(' ');
}

function dialogNote(_tabId, d) {
  return `It opened ${describeDialog(d)}. ${dialogHint(d)}`;
}

// ---- click / hover -----------------------------------------------------------------------------

export async function click({ tab, s }, args) {
  const p = await targetPoint(s, args);
  const button = args.button ?? 'left';
  const clickCount = args.click_count ?? 1;
  const modifiers = modifierBits(args.modifiers);
  const before = (await tabSummary(tab.id)).url;
  const w = s.navWatch();
  const newTabs = watchNewTabs(tab.id);
  try {
    const r = await s.raceDialog(mouseClick(s, p.x, p.y, { button, clickCount, modifiers }));
    const how = [
      clickCount === 2 ? 'Double-clicked' : clickCount === 3 ? 'Triple-clicked' : button === 'right' ? 'Right-clicked' : button === 'middle' ? 'Middle-clicked' : 'Clicked',
    ];
    if (clickCount > 1 && button !== 'left') how.push(`(${button} button)`);
    const mods = args.modifiers?.length ? ` with ${args.modifiers.join('+')}` : '';
    const lines = [p.point
      ? `${how.join(' ')} at (${r0(p.x)}, ${r0(p.y)})${mods}, on ${p.desc}.`
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

export async function hover({ s }, args) {
  const p = await targetPoint(s, args);
  const r = await s.raceDialog(s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', modifiers: 0 }));
  const lines = [p.point ? `Moved the mouse to (${r0(p.x)}, ${r0(p.y)}), over ${p.desc}.` : `Moved the mouse over ${p.desc} at (${r0(p.x)}, ${r0(p.y)}).`];
  if (p.covered) lines.push(`Note: ${p.covered} is on top of it at that point.`);
  if (r.dialog) lines.push(dialogNote(s.tabId, r.dialog));
  return { content: [text(lines.join(' '))] };
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
const MAC_COMMANDS = {
  'Meta+KeyA': ['selectAll'], 'Meta+KeyC': ['copy'], 'Meta+KeyX': ['cut'], 'Meta+KeyV': ['paste'],
  'Meta+KeyZ': ['undo'], 'Meta+Shift+KeyZ': ['redo'],
  'Meta+ArrowLeft': ['moveToBeginningOfLine'], 'Meta+ArrowRight': ['moveToEndOfLine'],
  'Meta+ArrowUp': ['moveToBeginningOfDocument'], 'Meta+ArrowDown': ['moveToEndOfDocument'],
  'Alt+ArrowLeft': ['moveWordLeft'], 'Alt+ArrowRight': ['moveWordRight'],
  'Alt+Backspace': ['deleteWordBackward'], 'Meta+Backspace': ['deleteToBeginningOfLine'],
};

function macCommands(bits, def) {
  const name = [bits & MOD_BITS.Meta && 'Meta', bits & MOD_BITS.Alt && 'Alt', bits & MOD_BITS.Shift && 'Shift', def.code]
    .filter(Boolean).join('+');
  return MAC_COMMANDS[name];
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
    return { content: [text(lines.join(' '))] };
  } finally {
    w.stop();
  }
}

// ---- type --------------------------------------------------------------------------------------

export async function type({ tab, s }, args) {
  if (args.ref != null && args.selector != null) throw bad('Pass `ref` or `selector`, not both.');
  const target = { ref: args.ref, selector: args.selector };
  let desc;
  let editable = true;
  if (args.ref != null || args.selector != null) {
    const f = await s.lib('focus', [target]);
    desc = f.desc;
    editable = f.editable;
    if (!f.focused) {
      // Not focusable by script (e.g. a wrapper element): click it like a user would.
      const p = await s.lib('point', [target]);
      const r = await s.raceDialog(mouseClick(s, p.x, p.y));
      if (r.dialog) return { content: [text(`Clicked ${desc} to focus it. ${dialogNote(tab.id, r.dialog)}`)] };
      const a = await s.lib('active');
      if (a.none) throw new ToolError('no_element', `${desc} could not be focused (clicking it did not focus anything), so there is nowhere to type. Pick an input, textarea or editable element.`);
      desc = a.desc;
      editable = a.editable;
    }
  } else {
    const a = await s.lib('active');
    if (a.none) throw new ToolError('no_element', 'No element is focused. Pass `ref` or `selector` to say where to type.');
    desc = a.desc;
    editable = a.editable;
  }
  let cleared = false;
  if (args.clear) {
    const sel = await s.lib('selectAllInFocused');
    if (sel.len > 0) {
      const r = await s.raceDialog(pressCombo(s, parseKey('Backspace')));
      if (r.dialog) return { content: [text(`Cleared ${desc}. ${dialogNote(tab.id, r.dialog)}`)] };
      if ((await s.lib('focusedLength')) > 0) await s.lib('forceClear');
    }
    cleared = true;
  }
  if (args.text.length) {
    const r = await s.raceDialog(s.send('Input.insertText', { text: args.text }, { timeoutMs: 20000 }));
    if (r.dialog) return { content: [text(`Typed into ${desc}. ${dialogNote(tab.id, r.dialog)}`)] };
  }
  const n = [...args.text].length;
  const lines = [`Typed ${n} character${n === 1 ? '' : 's'} into ${desc}${cleared ? ' (after clearing it)' : ''}.`];
  if (!editable) lines.push('Note: it is not a text field, so the text may not have gone anywhere; check with read_page.');
  if (!args.submit) {
    try {
      const a = await s.lib('active', [], { timeoutMs: 3000 });
      if (!a.none && a.value != null && !a.password) lines.push(`Its value is now ${q(a.value, 200)}.`);
    } catch { /* ignore */ }
  } else {
    const before = (await tabSummary(tab.id)).url;
    const w = s.navWatch();
    try {
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

const sameScroll = (a, b) => a.page.x === b.page.x && a.page.y === b.page.y
  && (a.inner?.top ?? 0) === (b.inner?.top ?? 0) && (a.inner?.left ?? 0) === (b.inner?.left ?? 0);

export async function scroll({ s }, args) {
  const hasEl = args.ref != null || args.selector != null;
  if (args.ref != null && args.selector != null) throw bad('Pass `ref` or `selector`, not both.');
  if (hasEl && (args.x != null || args.y != null)) throw bad('Pass either an element (`ref`/`selector`) or a point (`x`, `y`), not both.');
  if (hasEl && args.direction == null) {
    const r = await s.lib('scrollTo', [{ ref: args.ref, selector: args.selector }]);
    const st = await s.lib('scrollState', [{}]);
    return { content: [text(`Scrolled ${r.desc} into view; its centre is now at (${r.x}, ${r.y}). ${scrollSummary(st)}`)] };
  }
  const dir = args.direction ?? 'down';
  let x;
  let y;
  if (hasEl) {
    const p = await s.lib('point', [{ ref: args.ref, selector: args.selector }]);
    ({ x, y } = p);
  } else if (args.x != null || args.y != null) {
    if (args.x == null || args.y == null) throw bad('Pass both `x` and `y`.');
    await s.lib('at', [{ x: args.x, y: args.y }]); // validates the point
    ({ x, y } = args);
  } else {
    const m = await s.lib('metrics');
    x = Math.floor(m.vw / 2);
    y = Math.floor(m.vh / 2);
  }
  const before = await s.lib('scrollState', [{ x, y }]);
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
    const now = await s.lib('scrollState', [{ x, y }]);
    if (!sameScroll(now, after)) { after = now; stableSince = Date.now(); }
    if (Date.now() - stableSince > (sameScroll(after, before) ? 300 : 150)) break;
  }
  if (sameScroll(after, before)) {
    await s.lib('scrollByJs', [{ x, y, dx, dy }]);
    after = await s.lib('scrollState', [{ x, y }]);
  }
  const lines = [];
  if (sameScroll(after, before)) {
    lines.push(`Nothing scrolled ${dir}: the page${before.inner ? ' and the scrollable area at that point are' : ' is'} already at the ${{ up: 'top', down: 'bottom', left: 'left edge', right: 'right edge' }[dir]}, or the area at (${r0(x)}, ${r0(y)}) can't scroll.`);
  } else if (after.inner && before.inner && (after.inner.top !== before.inner.top || after.inner.left !== before.inner.left)) {
    const i = after.inner;
    lines.push(`Scrolled ${dir} inside ${i.desc}: its scroll position is now top=${i.top}, left=${i.left} (max top=${i.maxTop}, max left=${i.maxLeft}).`);
  } else {
    const moved = vertical ? Math.abs(after.page.y - before.page.y) : Math.abs(after.page.x - before.page.x);
    lines.push(`Scrolled ${dir} ${moved} px.`);
  }
  lines.push(scrollSummary(after));
  return { content: [text(lines.join(' '))] };
}

// ---- select_option -----------------------------------------------------------------------------

export async function selectOption({ s }, args) {
  if (args.ref != null && args.selector != null) throw bad('Pass `ref` or `selector`, not both.');
  if (args.ref == null && args.selector == null) throw bad('Pass `ref` or `selector` for the <select>.');
  const values = Array.isArray(args.value) ? args.value : [args.value];
  const r = await s.lib('selectOption', [{ ref: args.ref, selector: args.selector, values }]);
  if (!r.matched) {
    const list = r.options.map((o) => `value=${JSON.stringify(o.value)} label=${JSON.stringify(o.label)}${o.disabled ? ' (disabled)' : ''}`).join('\n');
    throw new ToolError('not_found', `No option of ${r.desc} matches ${values.map((v) => q(v)).join(', ')} (by value or label). Options${r.total > r.options.length ? ` (first ${r.options.length} of ${r.total})` : ''}:\n${untrusted(list || '(none)')}`);
  }
  const lines = [`Selected ${r.chosen.map((c) => q(c)).join(', ') || '(nothing)'} in ${r.desc}.`];
  if (r.unmatched.length) lines.push(`Not found (by value or label): ${r.unmatched.map((v) => q(v)).join(', ')}.`);
  if (!r.multiple && values.length > 1) lines.push('It is a single-choice <select>, so only the first match was used.');
  return { content: [text(lines.join(' '))] };
}

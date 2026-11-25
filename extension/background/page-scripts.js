// Code that runs inside web pages, in cctether's own isolated world ("cctether", created with
// Page.createIsolatedWorld). It is static code shipped with the extension: its source text is
// sent with Runtime.callFunctionOn. The page's scripts can't see this world's variables, but
// the DOM is shared.
//
// Rules for this file: cctetherPageLib must be self-contained (no references to anything outside
// the function: it is serialised with toString()). Library functions take one plain-object
// argument and return plain JSON values; expected failures are returned as
// { __error: { code, message } } and turned into ToolError by the caller.

export function cctetherPageLib() {
  'use strict';

  // ---- element refs: numbers that stay valid for the life of this document -------------------
  const refs = new Map(); // number -> WeakRef<Element>
  const refOf = new WeakMap(); // Element -> number
  let nextRef = 1;

  function ref(el) {
    const n = refOf.get(el);
    if (n && refs.get(n)?.deref() === el) return n;
    const m = nextRef++;
    refs.set(m, new WeakRef(el));
    refOf.set(el, m);
    return m;
  }

  /**
   * Expected failure. `list`: lines of page-derived text (candidates), which the caller appends to
   * the message marked as untrusted page content.
   */
  const ERR = (code, message, list) => ({ __error: list ? { code, message, list } : { code, message } });
  const AGAIN = 'Call read_page (mode "interactive") or find again to get fresh numbers.';
  /** Identifies this document: the library is set up again in every new document. */
  const docToken = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;

  /**
   * The element a tool means. A selector picks the first visible match (pages often keep hidden
   * copies: mobile menus, templates), else the first match; with { firstMatch: true }, the first
   * match in document order (for reading HTML, and for native selects that custom dropdowns hide).
   * Text (optionally within a selector) picks the one visible element with exactly that text or
   * name, and refuses when there is none or more than one (see byText).
   */
  function resolve(t, { firstMatch = false } = {}) {
    // Numbers start again at 1 in every document: a caller that got a number from an earlier
    // call passes that document's token, so a navigation in between can't redirect it.
    if (t && t.doc != null && t.doc !== docToken) {
      return ERR('stale_ref', 'The page navigated or reloaded in the meantime, so cctether stopped. Check the page and try again.');
    }
    if (t && t.ref != null) {
      const el = refs.get(t.ref)?.deref();
      if (!el) {
        return ERR('stale_ref', `Element ${t.ref} is not known on the current page (numbers are reset when the page navigates or reloads). ${AGAIN}`);
      }
      if (!el.isConnected) return ERR('stale_ref', `Element ${t.ref} has been removed from the page. ${AGAIN}`);
      return el;
    }
    if (t && t.text != null) return byText(t.text, t.selector);
    if (t && t.selector != null) {
      let list;
      try { list = document.querySelectorAll(t.selector); } catch (e) {
        return ERR('bad_args', `Invalid CSS selector ${JSON.stringify(t.selector)}: ${e.message}`);
      }
      if (!list.length) return ERR('no_element', `No element matches the selector ${JSON.stringify(t.selector)}. Check it with find, or use wait_for if it appears later.`);
      if (!firstMatch) for (const el of list) if (rendered(el)) return el;
      return list[0];
    }
    return ERR('bad_args', 'Pass ref or selector to say which element.');
  }

  function rootOf(selector) {
    if (!selector) return document.body || document.documentElement;
    return resolve({ selector });
  }

  // ---- small helpers ---------------------------------------------------------------------------
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const vw = () => window.innerWidth || document.documentElement.clientWidth;
  const vh = () => window.innerHeight || document.documentElement.clientHeight;

  function rendered(el) {
    if (typeof el.checkVisibility === 'function'
        && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  /** '' if the rect is (partly) inside the viewport, else an arrow saying where it is. */
  function where(r) {
    if (r.bottom <= 0) return '↑';
    if (r.top >= vh()) return '↓';
    if (r.right <= 0) return '←';
    if (r.left >= vw()) return '→';
    return '';
  }

  function fullyVisible(r) {
    return r.top >= 0 && r.left >= 0 && r.bottom <= vh() && r.right <= vw();
  }

  function scrollIntoViewCentered(el) {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    }
  }

  function composedContains(ancestor, node) {
    for (let n = node; n; n = n.parentNode || n.host) if (n === ancestor) return true;
    return false;
  }

  /** Parent element, stepping out of a shadow root to its host. */
  const parentOf = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;

  /** Element children, including those of an open shadow root. */
  function kidsOf(node) {
    return node.shadowRoot ? [...node.shadowRoot.children, ...node.children] : [...node.children];
  }

  const SCROLLS = /(auto|scroll|overlay|hidden)/;

  /** Ancestors that scroll (or clip and can be scrolled by script) in either direction. */
  function scrollers(el) {
    const out = [];
    for (let p = parentOf(el), i = 0; p && i < 60; p = parentOf(p), i++) {
      if (p === document.body || p === document.documentElement) break;
      const cs = getComputedStyle(p);
      const y = SCROLLS.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1;
      const x = SCROLLS.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1;
      if (x || y) out.push({ el: p, x, y });
      if (cs.position === 'fixed') break;
    }
    return out;
  }

  /** The part of rect r that the scrolling ancestors leave visible (may be empty). */
  function clipBy(list, r) {
    let { left, top, right, bottom } = r;
    for (const { el, x, y } of list) {
      const pr = el.getBoundingClientRect();
      if (x) { left = Math.max(left, pr.left + el.clientLeft); right = Math.min(right, pr.left + el.clientLeft + el.clientWidth); }
      if (y) { top = Math.max(top, pr.top + el.clientTop); bottom = Math.min(bottom, pr.top + el.clientTop + el.clientHeight); }
    }
    return { left, top, right, bottom };
  }

  const cutOff = (c, r) => c.left > r.left + 1 || c.top > r.top + 1 || c.right < r.right - 1 || c.bottom < r.bottom - 1;

  function deepElementFromPoint(x, y) {
    let h = document.elementFromPoint(x, y);
    while (h && h.shadowRoot) {
      const inner = h.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === h) break;
      h = inner;
    }
    return h;
  }

  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function editingHost(el) {
    if (!el || !el.isContentEditable) return null;
    let h = el;
    while (h.parentElement && h.parentElement.isContentEditable) h = h.parentElement;
    return h;
  }

  /** "div#pane.main" (no text): for big elements, whose text says nothing in particular. */
  function tagDesc(el) {
    let s = el.localName || '#node';
    if (el.id) s += `#${clip(el.id, 30)}`;
    const cls = [...(el.classList || [])].slice(0, 2).map((c) => clip(c, 30));
    if (cls.length) s += `.${cls.join('.')}`;
    const name = norm(el.getAttribute('aria-label') || '');
    return name ? `${s} ${JSON.stringify(clip(name, 40))}` : s;
  }

  function shortDesc(el) {
    if (!el) return 'nothing';
    let s = el.localName || '#node';
    if (el.id) s += `#${clip(el.id, 30)}`;
    const cls = [...(el.classList || [])].slice(0, 2).map((c) => clip(c, 30));
    if (cls.length) s += `.${cls.join('.')}`;
    const t = clip(norm(el.innerText || el.textContent || ''), 40);
    return t ? `${s} ${JSON.stringify(t)}` : s;
  }

  // ---- roles and accessible names --------------------------------------------------------------
  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem']);

  function inputKind(type) {
    switch (type) {
      case 'button': case 'submit': case 'reset': case 'image': return 'button';
      case 'checkbox': return 'checkbox';
      case 'radio': return 'radio';
      case 'range': return 'slider';
      case 'number': return 'spinbutton';
      case 'search': return 'searchbox';
      case 'file': return 'file';
      case 'color': return 'color';
      case 'date': case 'datetime-local': case 'month': case 'time': case 'week': return type;
      default: return 'textbox';
    }
  }

  /** Interactive kind of an element, or null. */
  function kindOf(el) {
    const tag = el.localName;
    const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
    const explicit = ROLES.has(role) ? role : null;
    switch (tag) {
      case 'a': case 'area': return el.hasAttribute('href') ? (explicit || 'link') : explicit;
      case 'button': return explicit || 'button';
      case 'input': return el.type === 'hidden' ? null : inputKind(el.type);
      case 'select': return 'select';
      case 'textarea': return 'textbox';
      case 'summary': return 'summary';
      case 'iframe': case 'frame': return 'iframe';
      case 'video': case 'audio': return el.controls ? tag : explicit;
      default: break;
    }
    if (explicit) return explicit;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    if (el.hasAttribute('onclick')) return 'clickable';
    if (el.hasAttribute('tabindex') && el.tabIndex >= 0) return 'focusable';
    return null;
  }

  function textOfIds(el, ids) {
    const root = el.getRootNode();
    return ids.split(/\s+/).map((id) => {
      const n = (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
      return n ? norm(n.innerText || n.textContent) : '';
    }).filter(Boolean).join(' ');
  }

  function labelText(label, control) {
    let t = label.innerText || label.textContent || '';
    if (label.contains(control)) {
      const own = control.innerText || '';
      if (own) t = t.replace(own, '');
    }
    return norm(t);
  }

  function accName(el) {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = textOfIds(el, lb); if (t) return t; }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return norm(al);
    const tag = el.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (tag === 'input' && (el.type === 'button' || el.type === 'submit' || el.type === 'reset')) {
        return norm(el.value || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : ''));
      }
      if (tag === 'input' && el.type === 'image') return norm(el.alt || el.value || 'Submit');
      if (el.labels && el.labels.length) {
        const t = [...el.labels].map((l) => labelText(l, el)).filter(Boolean).join(' ');
        if (t) return t;
      }
      const ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return norm(ph);
      return norm(el.getAttribute('title') || '');
    }
    if (tag === 'img' || tag === 'area') return norm(el.alt || el.title || '');
    if (tag === 'iframe' || tag === 'frame') return norm(el.title || el.name || '');
    if (el.isContentEditable) return norm(el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') || '');
    let t = norm(el.innerText || '');
    if (!t) { const img = el.querySelector('img[alt]'); if (img) t = norm(img.alt); }
    if (!t) { const st = el.querySelector('svg title'); if (st) t = norm(st.textContent); }
    if (!t) t = norm(el.getAttribute('title') || '');
    return t;
  }

  function shortHref(el) {
    const raw = el.getAttribute('href');
    if (raw == null) return '';
    if (/^\s*javascript:/i.test(raw)) return 'javascript:…';
    let u;
    try { u = new URL(el.href, location.href); } catch { return clip(raw, 100); }
    if (u.origin === location.origin) return clip(u.pathname + u.search + u.hash, 100);
    return clip(u.href, 100);
  }

  function selectedLabels(sel) {
    return [...sel.selectedOptions].map((o) => norm(o.label || o.text));
  }

  /** "button "Sign in"" etc. — used in tool results. */
  function label(el) {
    const kind = kindOf(el) || el.localName;
    const name = clip(accName(el), 60);
    return name ? `${kind} ${JSON.stringify(name)}` : (el.id ? `${kind}#${clip(el.id, 30)}` : kind);
  }

  // ---- finding elements by their text --------------------------------------------------------
  /** The best (lowest) of several tiers, or -1 if none matched. */
  function bestTier(tiers) {
    const ok = tiers.filter((t) => t >= 0);
    return ok.length ? Math.min(...ok) : -1;
  }

  /** How well `hay` matches: 0 exactly, 1 exactly but for case, 2 contains it, -1 not at all. */
  function tierOf(hay, needle, low) {
    if (!hay) return -1;
    if (hay === needle) return 0;
    const h = hay.toLowerCase();
    if (h === low) return 1;
    return h.includes(low) ? 2 : -1;
  }

  /** Names an interactive element carries in attributes rather than in its text. */
  function attrNames(el) {
    const out = [];
    const lb = el.getAttribute('aria-labelledby');
    if (lb) out.push(textOfIds(el, lb));
    const al = el.getAttribute('aria-label');
    if (al) out.push(norm(al));
    if (el.localName === 'input') {
      if (el.type === 'button' || el.type === 'submit' || el.type === 'reset') out.push(norm(el.value));
      if (el.type === 'image') out.push(norm(el.alt || ''));
    }
    const ph = el.getAttribute('placeholder');
    if (ph) out.push(norm(ph));
    // Icon-only controls: the name comes from an image's alt, an SVG title, or a title.
    if (!norm(el.textContent)) out.push(accName(el));
    return out.filter(Boolean);
  }

  const squash = (s) => String(s).replace(/\s+/g, '').toLowerCase();
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head']);

  /**
   * Visible elements whose text or name matches `text`, best first: [{ el, tier }] (see tierOf).
   * Without a selector: the innermost elements whose visible text holds it, each replaced by the
   * nearest link/button/option around it that has the same text; and interactive elements whose
   * name (aria-label, alt, placeholder...) matches. Open shadow roots are searched too. With a
   * selector: the visible elements matching it whose text or name matches.
   */
  function textMatches(text, selector) {
    const needle = norm(text);
    if (!needle) return ERR('bad_args', '`text` is empty.');
    const low = needle.toLowerCase();
    const found = new Map(); // Element -> best tier, in the order found
    const add = (el, tier) => {
      if (tier < 0 || el === document.body || el === document.documentElement) return;
      const had = found.get(el);
      if (had === undefined || tier < had) found.set(el, tier);
    };
    if (selector != null) {
      let list;
      try { list = document.querySelectorAll(selector); } catch (e) {
        return ERR('bad_args', `Invalid CSS selector ${JSON.stringify(selector)}: ${e.message}`);
      }
      let n = 0;
      for (const el of list) {
        if (++n > 5000) break;
        if (!rendered(el)) continue;
        add(el, tierOf(norm(el.innerText || ''), needle, low));
        add(el, bestTier([accName(el), ...attrNames(el)].map((x) => tierOf(x, needle, low))));
      }
    } else {
      // Cheap necessary condition first: rendered text is a rearrangement of the text content
      // (line breaks for <br> and blocks, CSS case changes), so compare without spaces and case.
      const sq = squash(needle);
      // Returns true if el or something inside it was added.
      const walk = (el) => {
        if (SKIP_TAGS.has(el.localName)) return false;
        let inner = false;
        for (const k of kidsOf(el)) if (walk(k)) inner = true;
        let hit = false;
        if (kindOf(el)) {
          const t = bestTier(attrNames(el).map((x) => tierOf(x, needle, low)));
          if (t >= 0 && rendered(el)) { add(el, t); hit = true; }
        }
        // Only the innermost holder of the text. Big containers are skipped: text spread over
        // a whole section names nothing in particular (and reading it all is slow).
        if (!inner) {
          const tc = el.textContent || '';
          if (tc.length <= 3000 && squash(tc).includes(sq) && rendered(el)) {
            const own = norm(el.innerText || '');
            const t = tierOf(own, needle, low);
            if (t >= 0) { add(lift(el, own), t); hit = true; }
          }
        }
        return inner || hit;
      };
      const top = document.body || document.documentElement;
      if (top) walk(top);
    }
    return [...found].map(([el, tier]) => ({ el, tier })).sort((a, b) => a.tier - b.tier);
  }

  /** The nearest link, button, option... (or label of a control) around el with the same visible text, else el. */
  function lift(el, own) {
    if (kindOf(el) || (el.localName === 'label' && labelled(el))) return el;
    let p = parentOf(el);
    for (let i = 0; p && i < 6; i++, p = parentOf(p)) {
      if (p === document.body || p === document.documentElement) break;
      if (norm(p.innerText || '') !== own) break;
      if (kindOf(p) || (p.localName === 'label' && labelled(p))) return p;
    }
    return el;
  }

  /**
   * A control and its own <label> name the same thing: keep one, the control if it can be
   * clicked, else the label (hidden radios and checkboxes).
   */
  function oneOfLabelled(ms) {
    const els = new Set(ms.map((m) => m.el));
    return ms.filter((m) => {
      const c = m.el.localName === 'label' ? labelled(m.el) : null;
      if (c && els.has(c) && usable(c)) return false;
      if (m.el.labels && m.el.labels.length && !usable(m.el) && [...m.el.labels].some((l) => els.has(l))) return false;
      return true;
    });
  }

  /** A line about a candidate element, with where it is, for "which one?" lists. */
  function candidate(el, tier) {
    const r = el.getBoundingClientRect();
    let s = `[${ref(el)}] ${label(el)} at (${Math.round(r.left + r.width / 2)}, ${Math.round(r.top + r.height / 2)})`;
    const w = where(r);
    if (w) s += ` ${w}`;
    // Some context to tell look-alikes apart, e.g. the table row an "Edit" button is in.
    const own = norm(el.innerText || accName(el));
    for (let p = parentOf(el), i = 0; p && i < 4; p = parentOf(p), i++) {
      if (p === document.body) break;
      const t = norm(p.innerText || '');
      if (t.length > own.length + 2) { s += ` in ${tagDesc(p)} ${JSON.stringify(clip(t, 70))}`; break; }
    }
    if (tier === 2) s += ' (contains it)';
    return s;
  }

  function candidates(ms) {
    const lines = ms.slice(0, 10).map((m) => candidate(m.el, m.tier));
    if (ms.length > 10) lines.push(`… and ${ms.length - 10} more`);
    return lines;
  }

  /** The single element a tool should act on, for `text` (and an optional selector). */
  function byText(text, selector) {
    const all = textMatches(text, selector);
    if (all.__error) return all;
    const want = JSON.stringify(clip(norm(text), 100));
    const scope = selector != null ? ` among elements matching ${JSON.stringify(selector)}` : '';
    let pick = oneOfLabelled(all.filter((m) => m.tier === 0));
    if (!pick.length) pick = oneOfLabelled(all.filter((m) => m.tier === 1));
    // A page title and a button often say the same ("Create snapshot"): when exactly one of the
    // exact matches is a link, button, option... that is the one meant.
    if (pick.length > 1) {
      const acting = pick.filter((m) => kindOf(m.el) || (m.el.localName === 'label' && labelled(m.el)));
      if (acting.length === 1) pick = acting;
    }
    if (pick.length === 1) return pick[0].el;
    if (pick.length > 1) {
      return ERR('ambiguous', `${pick.length} visible elements${scope} have the text ${want}, so cctether did not pick one. Pass the ref of the right one, or narrow it down with selector:`, candidates(pick));
    }
    if (all.length) {
      return ERR('no_element', `No visible element${scope} has exactly the text ${want}; ${all.length === 1 ? 'one contains' : `${all.length} contain`} it. Pass the ref of the right one, or its full text:`, candidates(all));
    }
    return ERR('no_element', `No visible element${scope} has the text ${want}. Check the page with read_page or screenshot, or use wait_for if it appears later.`);
  }

  function valueText(el) {
    if (el.localName === 'input' && el.type === 'password') return el.value ? `(${el.value.length} characters, hidden)` : '';
    if ('value' in el && (el.localName === 'input' || el.localName === 'textarea')) return el.value;
    const host = editingHost(el);
    if (host) return host.innerText;
    return null;
  }

  /**
   * One line of the interactive list. `at`: the element the number and position belong to, when
   * it stands in for el (a visible <label> for a hidden radio or checkbox).
   */
  function line(el, kind, at = el) {
    const parts = [`[${ref(at)}] ${kind}`];
    const name = accName(el);
    if (name) parts.push(JSON.stringify(clip(name, 80)));
    const tag = el.localName;
    if (kind === 'combobox' && tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
      // What it displays, which may be a placeholder: hence "shows", not "=".
      const shown = norm(el.innerText || '');
      if (shown && shown !== norm(name)) parts.push(`shows ${JSON.stringify(clip(shown, 80))}`);
    }
    if (tag === 'input' && kind === 'textbox' && el.type !== 'text') parts.push(`type=${el.type}`);
    if (kind === 'link' || (tag === 'a' && el.hasAttribute('href'))) {
      const h = shortHref(el);
      if (h) parts.push(`→ ${h}`);
    }
    if (tag === 'select') {
      const s = selectedLabels(el);
      if (el.multiple) parts.push(`multiple = ${JSON.stringify(s.map((x) => clip(x, 40)))}`);
      else if (s.length) parts.push(`= ${JSON.stringify(clip(s[0], 60))}`);
    } else if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
      if (el.indeterminate) parts.push('mixed');
      else if (el.checked) parts.push('checked');
    } else if (tag === 'input' || tag === 'textarea') {
      if (el.type === 'password') {
        if (el.value) parts.push(`value=(${el.value.length} characters, hidden)`);
      } else if (el.type !== 'button' && el.type !== 'submit' && el.type !== 'reset' && el.type !== 'image' && el.value) {
        parts.push(`value=${JSON.stringify(clip(el.value, 80))}`);
      }
    } else if (kind === 'textbox' && el.isContentEditable) {
      const v = norm(el.innerText);
      parts.push(v ? `editable value=${JSON.stringify(clip(v, 80))}` : 'editable');
    } else if (kind === 'iframe') {
      const src = el.getAttribute('src');
      if (src) parts.push(`→ ${clip(src, 100)}`);
    }
    const ac = el.getAttribute('aria-checked');
    if (ac === 'true' && !(tag === 'input')) parts.push('checked');
    else if (ac === 'mixed') parts.push('mixed');
    if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') parts.push('pressed');
    const ex = el.getAttribute('aria-expanded');
    if (ex === 'true') parts.push('expanded');
    else if (ex === 'false') parts.push('collapsed');
    if (tag === 'details' || (tag === 'summary' && el.parentElement?.localName === 'details')) {
      parts.push(el.parentElement?.open ? 'expanded' : 'collapsed');
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    if (el.readOnly) parts.push('readonly');
    const w = where(at.getBoundingClientRect());
    if (w) parts.push(w);
    return parts.join(' ');
  }

  // ---- read_page -------------------------------------------------------------------------------
  function tidy(t) {
    return String(t).replace(/\r\n?/g, '\n').replace(/[ \t ]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function readText(o) {
    const root = rootOf(o.selector);
    if (root.__error) return root;
    const text = tidy(root.innerText ?? root.textContent ?? '');
    return { title: document.title, url: location.href, text };
  }

  /**
   * Can a user (and a click at its centre) reach this control? Not when it is hidden, a pixel or
   * two in size (the "visually hidden" pattern), clipped away, or moved off the page.
   */
  function usable(el) {
    if (!rendered(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0) return false;
    const cp = getComputedStyle(el).clipPath || '';
    return !/inset\(\s*50%/.test(cp);
  }

  /** The control a <label> is for, if it is another element. */
  function labelled(lab) {
    return lab.control && lab.control !== lab ? lab.control : null;
  }

  /**
   * The only interactive element inside `node`, if there is exactly one and it has node's text:
   * then a wrapper that is listed only for its pointer cursor or onclick adds nothing.
   */
  function soleControl(node) {
    const text = norm(node.innerText || '');
    if (!text || text.length > 200) return null;
    let found = null;
    let n = 0;
    for (const d of node.querySelectorAll('*')) {
      if (++n > 300) return null;
      if (kindOf(d) && rendered(d)) {
        if (found) return null;
        found = d;
      }
    }
    if (!found) return null;
    return norm(found.innerText || '') === text || accName(found) === text ? found : null;
  }

  function isDialog(el) {
    const r = roleOf(el);
    return (el.localName === 'dialog' && el.open) || r === 'dialog' || r === 'alertdialog' || el.getAttribute('aria-modal') === 'true';
  }

  /** The dialog an element is in (the element), or 'main' / 'nav' (nearest landmark), or 'rest'. */
  function sectionOf(el) {
    let nearest = null;
    for (let p = el, i = 0; p && i < 300; p = parentOf(p), i++) {
      if (isDialog(p)) return p;
      if (!nearest) {
        const r = roleOf(p);
        if (p.localName === 'main' || r === 'main') nearest = 'main';
        else if (p.localName === 'nav' || r === 'navigation') nearest = 'nav';
      }
    }
    return nearest || 'rest';
  }

  function interactive(o) {
    const root = rootOf(o.selector);
    if (root.__error) return root;
    const max = o.max || 3000;
    const items = []; // { el, kind, at }
    const represented = new WeakSet(); // controls a <label> stands in for
    const reachableLabel = (c) => [...(c.labels || [])].some((l) => rendered(l) && composedContains(root, l));
    // Iterative DFS in document order, piercing open shadow roots. `inside` = an ancestor is
    // already listed (then cursor:pointer alone doesn't make a descendant interesting).
    const stack = [[root, false]];
    while (stack.length) {
      const [node, inside] = stack.pop();
      let listed = false;
      if (node.nodeType === 1) {
        const control = node.localName === 'label' ? labelled(node) : null;
        if (control) {
          // A label is listed only to stand in for a control that can't be clicked itself
          // (hidden radios and checkboxes); otherwise the control's own line is enough.
          const kind = kindOf(control);
          if (kind && !represented.has(control) && !usable(control) && rendered(node)) {
            represented.add(control);
            items.push({ el: control, kind, at: node });
            listed = true;
          }
        } else {
          let kind = kindOf(node);
          let heuristic = kind === 'clickable' || kind === 'focusable';
          if (!kind && !inside && node !== document.body && node !== document.documentElement) {
            const cs = getComputedStyle(node);
            if (cs.cursor === 'pointer' && (!node.parentElement || getComputedStyle(node.parentElement).cursor !== 'pointer')) {
              kind = 'clickable';
              heuristic = true;
            }
          }
          if (kind && rendered(node) && !represented.has(node)
              && !(heuristic && soleControl(node))
              && !(!usable(node) && reachableLabel(node))) {
            items.push({ el: node, kind, at: node });
            listed = true;
          }
        }
        if (node.localName === 'select' || node.localName === 'iframe') continue;
      }
      const kids = kidsOf(node);
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], inside || listed]);
    }
    // Without a selector: open dialogs first, then the main content, then the rest, navigation
    // last, so that a long sidebar doesn't push the content out of the first page of output.
    let order = items;
    const heads = new Map(); // index in order -> heading line
    if (o.selector == null) {
      const dialogs = new Map();
      const main = [];
      const rest = [];
      const nav = [];
      for (const it of items) {
        const sec = sectionOf(it.at);
        if (sec === 'main') main.push(it);
        else if (sec === 'nav') nav.push(it);
        else if (sec === 'rest') rest.push(it);
        else { if (!dialogs.has(sec)) dialogs.set(sec, []); dialogs.get(sec).push(it); }
      }
      if (dialogs.size || main.length || nav.length) {
        order = [];
        const section = (title, list) => {
          if (!list.length) return;
          heads.set(order.length, `## ${title} (${list.length})`);
          order.push(...list);
        };
        // The dialog opened last is usually the one on top.
        for (const [d, list] of [...dialogs].reverse()) {
          const name = norm(d.getAttribute('aria-label') || (d.getAttribute('aria-labelledby') ? textOfIds(d, d.getAttribute('aria-labelledby')) : ''));
          section(`Dialog${name ? ` ${JSON.stringify(clip(name, 60))}` : ''}`, list);
        }
        section('Main content', main);
        section(dialogs.size || main.length ? 'Rest of the page' : 'Page', rest);
        section('Navigation', nav);
      }
    }
    const lines = [];
    const shown = Math.min(max, order.length);
    for (let i = 0; i < shown; i++) {
      if (heads.has(i)) lines.push(heads.get(i));
      lines.push(line(order[i].el, order[i].kind, order[i].at));
    }
    return { title: document.title, url: location.href, lines, total: items.length, shown, grouped: heads.size > 0, vw: vw(), vh: vh() };
  }

  function html(o) {
    const root = o.selector ? resolve({ selector: o.selector }, { firstMatch: true }) : (document.body || document.documentElement);
    if (root.__error) return root;
    // Work on a copy inside an inert document: nothing in it loads or runs.
    const doc = document.implementation.createHTMLDocument('');
    const clone = doc.importNode(root, true);
    let scripts = 0;
    let styles = 0;
    let attrs = 0;
    const all = [clone, ...clone.querySelectorAll('*')];
    for (const e of all) {
      if ((e.localName === 'script' || e.localName === 'style') && e.textContent.length) {
        const n = e.textContent.length;
        e.textContent = `/* ${n} chars removed */`;
        if (e.localName === 'script') scripts++; else styles++;
      }
      for (const a of [...(e.attributes || [])]) {
        if (a.value.length > 300) {
          e.setAttribute(a.name, `${a.value.slice(0, 200)}…(${a.value.length} chars)`);
          attrs++;
        }
      }
    }
    return { title: document.title, url: location.href, html: clone.outerHTML, scripts, styles, attrs };
  }

  // ---- find ------------------------------------------------------------------------------------
  const FIND_ATTRS = ['name', 'type', 'href', 'role', 'aria-label', 'placeholder', 'title', 'alt', 'for', 'src'];

  function find(o) {
    let list;
    let tiers = null;
    if (o.text != null) {
      const ms = textMatches(o.text, o.selector);
      if (ms.__error) return ms;
      list = ms.map((m) => m.el);
      tiers = ms.map((m) => m.tier);
    } else {
      try { list = document.querySelectorAll(o.selector); } catch (e) {
        return ERR('bad_args', `Invalid CSS selector ${JSON.stringify(o.selector)}: ${e.message}`);
      }
    }
    const items = [];
    const n = Math.min(list.length, o.limit || 20);
    for (let i = 0; i < n; i++) {
      const el = list[i];
      const r = el.getBoundingClientRect();
      const attrs = [];
      for (const a of FIND_ATTRS) {
        const v = el.getAttribute(a);
        if (v != null && v !== '') attrs.push(`${a}=${JSON.stringify(clip(v, a === 'href' || a === 'src' ? 120 : 60))}`);
      }
      const v = valueText(el);
      if ((el.localName === 'input' || el.localName === 'textarea') && v) attrs.push(`value=${JSON.stringify(clip(v, 80))}`);
      if (el.localName === 'select') attrs.push(`value=${JSON.stringify(clip(selectedLabels(el).join(', '), 80))}`);
      if (el.checked) attrs.push('checked');
      if (el.disabled) attrs.push('disabled');
      const vis = rendered(el) ? (where(r) ? `offscreen ${where(r)}` : 'visible') : 'hidden';
      let text = '';
      if (el.localName !== 'select' && el.localName !== 'input' && el.localName !== 'textarea') {
        text = clip(norm(el.innerText ?? el.textContent ?? ''), 100);
      }
      let tag = el.localName;
      if (el.id) tag += `#${clip(el.id, 40)}`;
      const cls = [...el.classList].slice(0, 3).map((c) => clip(c, 30));
      if (cls.length) tag += `.${cls.join('.')}`;
      items.push({
        ref: ref(el), tag, attrs, text, vis,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        contains: tiers ? tiers[i] === 2 : false,
      });
    }
    return { count: list.length, exact: tiers ? tiers.filter((t) => t < 2).length : null, items };
  }

  // ---- pointer targets -------------------------------------------------------------------------
  /** Scroll the element into view and pick the point a user would click. */
  function point(o) {
    const el = resolve(o);
    if (el.__error) return el;
    // Also scroll it in when a scrolling box around it cuts it off (an option far down a list),
    // even if that part of the box is inside the viewport.
    const sc = scrollers(el);
    const r0 = el.getBoundingClientRect();
    if (!fullyVisible(r0) || cutOff(clipBy(sc, r0), r0)) scrollIntoViewCentered(el);
    const rects = [...el.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
    if (!rects.length || !rendered(el)) {
      return ERR('no_element', `${label(el)} is not visible (hidden or zero size). Check it with find, or wait_for it to appear.`);
    }
    const W = vw();
    const H = vh();
    const rr = rects.find((x) => x.bottom > 0 && x.right > 0 && x.top < H && x.left < W) || rects[0];
    let left = Math.max(rr.left, 0);
    let right = Math.min(rr.right, W);
    let top = Math.max(rr.top, 0);
    let bottom = Math.min(rr.bottom, H);
    // Aim at the part the scrolling boxes leave visible (if the calculation finds none, e.g. for
    // a positioned element that escapes its box, keep the viewport part).
    const c = clipBy(sc, { left, top, right, bottom });
    if (c.right > c.left && c.bottom > c.top) ({ left, top, right, bottom } = c);
    if (right <= left || bottom <= top) {
      return ERR('no_element', `${label(el)} could not be scrolled into the viewport.`);
    }
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const hit = deepElementFromPoint(x, y);
    let covered = null;
    if (hit && hit !== el && !composedContains(el, hit)) {
      const viaLabel = el.labels && [...el.labels].some((l) => composedContains(l, hit));
      if (!viaLabel) covered = shortDesc(hit);
    }
    return { x, y, desc: label(el), covered, ref: ref(el), doc: docToken };
  }

  /** What is at a viewport point. */
  function at(o) {
    const W = vw();
    const H = vh();
    if (o.x < 0 || o.y < 0 || o.x >= W || o.y >= H) {
      return ERR('bad_args', `(${o.x}, ${o.y}) is outside the viewport, which is ${W}×${H} CSS pixels. Scroll first, or use ref/selector.`);
    }
    const hit = deepElementFromPoint(o.x, o.y);
    return { desc: hit ? label(hit) : 'nothing', vw: W, vh: H };
  }

  function elementRect(o) {
    const el = resolve(o);
    if (el.__error) return el;
    let r = el.getBoundingClientRect();
    if (!fullyVisible(r)) {
      if (r.height > vh() || r.width > vw()) {
        try { el.scrollIntoView({ block: 'start', inline: 'start', behavior: 'instant' }); } catch { el.scrollIntoView(true); }
      } else {
        scrollIntoViewCentered(el);
      }
      r = el.getBoundingClientRect();
    }
    if (!(r.width > 0 && r.height > 0)) {
      return ERR('no_element', `${label(el)} has no size (it is hidden or empty), so there is nothing to screenshot.`);
    }
    return { x: r.left, y: r.top, width: r.width, height: r.height, desc: label(el), vw: vw(), vh: vh() };
  }

  function metrics() {
    const se = document.scrollingElement || document.documentElement;
    return {
      dpr: window.devicePixelRatio || 1,
      vw: vw(), vh: vh(),
      scrollX: window.scrollX, scrollY: window.scrollY,
      docW: Math.max(se.scrollWidth, document.documentElement.clientWidth),
      docH: Math.max(se.scrollHeight, document.documentElement.clientHeight),
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      doc: docToken,
      // When this document's navigation started (ms since 1970).
      t0: performance.timeOrigin,
    };
  }

  /** Scroll the page so that page point (x, y) is in the middle of the viewport. */
  function scrollPageTo(o) {
    const se = document.scrollingElement || document.documentElement;
    try {
      se.scrollTo({ left: o.x - vw() / 2, top: o.y - vh() / 2, behavior: 'instant' });
    } catch {
      se.scrollTo(o.x - vw() / 2, o.y - vh() / 2);
    }
    return { scrollX: window.scrollX, scrollY: window.scrollY, doc: docToken };
  }

  // ---- typing ----------------------------------------------------------------------------------
  function isEditable(el) {
    if (!el) return false;
    if (el.localName === 'textarea') return !el.readOnly && !el.disabled;
    if (el.localName === 'input') {
      return !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'range', 'color', 'file', 'hidden'].includes(el.type)
        && !el.readOnly && !el.disabled;
    }
    return !!el.isContentEditable;
  }

  function focus(o) {
    const el = resolve(o);
    if (el.__error) return el;
    if (!fullyVisible(el.getBoundingClientRect())) scrollIntoViewCentered(el);
    if (el.disabled) return ERR('no_element', `${label(el)} is disabled, so it can't be typed into.`);
    try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
    const a = deepActive();
    const focused = !!a && (a === el || composedContains(el, a));
    return { focused, desc: label(el), editable: isEditable(focused ? a : el) };
  }

  /** Describe the focused element. */
  function active() {
    const a = deepActive();
    if (!a || a === document.body || a === document.documentElement) return { none: true };
    const v = valueText(a);
    return { none: false, desc: label(a), editable: isEditable(a), value: v == null ? null : clip(v, 300), password: a.type === 'password' };
  }

  /** Select the whole content of the focused field, so the next key press replaces it. */
  function selectAllInFocused() {
    const a = deepActive();
    if (!a) return { kind: 'none', len: 0 };
    if (a.localName === 'input' || a.localName === 'textarea') {
      try { a.select(); } catch { /* some input types can't be selected */ }
      return { kind: 'field', len: a.value.length };
    }
    const host = editingHost(a);
    if (host) {
      const range = document.createRange();
      range.selectNodeContents(host);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return { kind: 'editable', len: host.innerText.replace(/\n$/, '').length };
    }
    return { kind: 'other', len: 0 };
  }

  function focusedLength() {
    const a = deepActive();
    if (!a) return 0;
    if (a.localName === 'input' || a.localName === 'textarea') return a.value.length;
    const host = editingHost(a);
    return host ? host.innerText.replace(/\n$/, '').length : 0;
  }

  /** Last resort for clearing: set the value directly and fire an input event. */
  function forceClear() {
    const a = deepActive();
    if (!a) return false;
    if (a.localName === 'input' || a.localName === 'textarea') {
      const proto = a.localName === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(a, '');
      a.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
      a.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const host = editingHost(a);
    if (host) {
      host.textContent = '';
      host.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
      return true;
    }
    return false;
  }

  // ---- select_option ---------------------------------------------------------------------------
  function selectOption(o) {
    const el = resolve(o, { firstMatch: true });
    if (el.__error) return el;
    if (el.localName !== 'select') {
      return ERR('bad_args', `${label(el)} is a <${el.localName}>, not a <select>. For a custom dropdown, click it to open it, then click the option (read_page mode "interactive" lists them).`);
    }
    if (el.disabled) return ERR('bad_args', `${label(el)} is disabled.`);
    const opts = [...el.options];
    const chosen = [];
    const unmatched = [];
    for (const v of o.values) {
      const nv = norm(v);
      const opt = opts.find((x) => x.value === v)
        || opts.find((x) => norm(x.label || x.text) === nv)
        || opts.find((x) => norm(x.label || x.text).toLowerCase() === nv.toLowerCase());
      if (opt && !opt.disabled) { if (!chosen.includes(opt)) chosen.push(opt); } else unmatched.push(v);
    }
    if (!chosen.length) {
      return {
        matched: false,
        desc: label(el),
        options: opts.slice(0, 30).map((x) => ({ value: x.value, label: norm(x.label || x.text), disabled: x.disabled })),
        total: opts.length,
      };
    }
    if (el.multiple) {
      for (const x of opts) x.selected = chosen.includes(x);
    } else {
      chosen.length = 1;
      el.value = chosen[0].value;
      chosen[0].selected = true;
    }
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { matched: true, desc: label(el), chosen: selectedLabels(el), unmatched, multiple: el.multiple };
  }

  // ---- ARIA dropdowns (select_option on something that is not a <select>) ----------------------
  const OPTION_ROLES = new Set(['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem']);
  function roleOf(el) {
    return (el.getAttribute('role') || '').trim().split(/\s+/)[0].toLowerCase();
  }

  /** Does it say it is a dropdown (or a list of options)? Menus of commands don't count. */
  function declaresList(el) {
    const r = roleOf(el);
    return r === 'combobox' || r === 'listbox' || (el.getAttribute('aria-haspopup') || '').trim().toLowerCase() === 'listbox';
  }

  /** The declared dropdown el is, is inside, or contains exactly one of; else null. */
  function dropdownOf(el) {
    if (declaresList(el)) return el;
    for (let p = parentOf(el), i = 0; p && i < 5; p = parentOf(p), i++) {
      if (p === document.body) break;
      if (declaresList(p)) return p;
    }
    const inner = [...el.querySelectorAll('[role],[aria-haspopup]')].filter((x) => declaresList(x) && rendered(x));
    return inner.length === 1 ? inner[0] : null;
  }

  function byIds(el, attr) {
    const ids = (el.getAttribute(attr) || '').trim();
    if (!ids) return [];
    const root = el.getRootNode();
    return ids.split(/\s+/).map((id) => (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id)).filter(Boolean);
  }

  /** Rendered option-like elements under root (open shadow roots too), in document order. */
  function optionsIn(root, out) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (n.nodeType === 1 && OPTION_ROLES.has(roleOf(n)) && rendered(n) && !out.includes(n)) out.push(n);
      const kids = kidsOf(n);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  }

  const optionLabel = (el) => norm(el.innerText || '') || norm(el.getAttribute('aria-label') || '');
  const isOn = (el) => el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true';

  /** What a dropdown displays as its choice now. */
  function shownValue(el) {
    if (roleOf(el) === 'listbox') return optionsIn(el, []).filter(isOn).map(optionLabel).join(', ');
    if (el.localName === 'input' || el.localName === 'textarea') return el.value;
    return norm(el.innerText || '');
  }

  function ddTarget(o) {
    const el = resolve(o, { firstMatch: true });
    if (el.__error) return el;
    if (el.localName === 'select') return { native: true };
    const d = dropdownOf(el);
    if (!d) {
      return ERR('bad_args', `${label(el)} is a <${el.localName}>: not a <select>, and it doesn't say it is a dropdown (role "combobox" or "listbox", or aria-haspopup="listbox"), so cctether won't guess how to use it. Click it to open it, then click the option (click with text, or a ref from read_page mode "interactive").`);
    }
    if (d.disabled || d.getAttribute('aria-disabled') === 'true') return ERR('bad_args', `${label(d)} is disabled.`);
    const name = clip(accName(d), 60);
    const kind = kindOf(d) || roleOf(d) || d.localName;
    return {
      native: false, ref: ref(d), doc: docToken, desc: name ? `${kind} ${JSON.stringify(name)}` : kind, list: roleOf(d) === 'listbox',
      expanded: d.getAttribute('aria-expanded') === 'true', shown: shownValue(d),
    };
  }

  /**
   * The options of a dropdown: in the list(s) it names with aria-controls / aria-owns (read now:
   * many widgets set them only while open), else inside it. Never "options that appeared".
   */
  function ddList(o) {
    const d = resolve({ ref: o.ref, doc: o.doc });
    if (d.__error) return d;
    let lists = roleOf(d) === 'listbox' ? [d] : [...byIds(d, 'aria-controls'), ...byIds(d, 'aria-owns')];
    if (!lists.length) lists = [d];
    const opts = [];
    for (const l of lists) optionsIn(l, opts);
    const multi = lists.some((l) => l.getAttribute('aria-multiselectable') === 'true');
    return { named: lists[0] !== d, expanded: d.getAttribute('aria-expanded') === 'true', multi, opts };
  }

  const optionInfo = (x) => ({
    ref: ref(x), label: optionLabel(x), value: x.getAttribute('data-value') ?? x.getAttribute('value'),
    disabled: x.getAttribute('aria-disabled') === 'true' || x.disabled === true, selected: isOn(x),
  });

  /** How many options the dropdown has now, and the first few. */
  function ddOptions(o) {
    const r = ddList(o);
    if (r.__error) return r;
    return { named: r.named, expanded: r.expanded, multi: r.multi, total: r.opts.length, options: r.opts.slice(0, 30).map(optionInfo) };
  }

  /**
   * The option for o.value, matched over all of the dropdown's options: by value (data-value /
   * value), label exactly, label ignoring case, else a label containing it. The first of these
   * that matches anything decides, and it must match exactly one. Returns { option } or
   * { many, how } (the first 30 of them) or { none: true, options (the first 30), total }.
   */
  function ddPick(o) {
    const r = ddList(o);
    if (r.__error) return r;
    const all = r.opts.map((x) => ({ el: x, label: optionLabel(x), value: x.getAttribute('data-value') ?? x.getAttribute('value') }));
    const nv = norm(o.value);
    const lv = nv.toLowerCase();
    const tiers = [
      ['have that value', (x) => x.value != null && x.value === o.value],
      ['have that label', (x) => x.label === nv],
      ['have that label (ignoring case)', (x) => x.label.toLowerCase() === lv],
      ['contain it', (x) => lv !== '' && x.label.toLowerCase().includes(lv)],
    ];
    for (const [how, f] of tiers) {
      const hits = all.filter(f);
      if (hits.length === 1) return { option: optionInfo(hits[0].el), multi: r.multi };
      if (hits.length > 1) return { many: hits.slice(0, 30).map((h) => optionInfo(h.el)), count: hits.length, how };
    }
    return { none: true, options: r.opts.slice(0, 30).map(optionInfo), total: r.opts.length };
  }

  /**
   * Last check before pressing at (x, y): the value still picks the same option (same value and
   * label, enabled), and the element on top at that point is that option.
   */
  function ddFinal(o) {
    const r = ddPick({ ref: o.ref, doc: o.doc, value: o.value });
    if (r.__error) return r;
    const opt = r.option;
    // (A null in the arguments arrives as a missing field: compare "no value" as one.)
    const same = !!opt && opt.ref === o.opt.ref && (opt.value ?? null) === (o.opt.value ?? null) && opt.label === o.opt.label && !opt.disabled;
    const el = refs.get(o.opt.ref)?.deref();
    const hit = deepElementFromPoint(o.x, o.y);
    const onTop = !!el && !!hit && (hit === el || composedContains(el, hit));
    return { same, now: opt || null, selected: !!opt?.selected, multi: !!r.multi, onTop, hit: hit ? shortDesc(hit) : 'nothing' };
  }

  /** What the dropdown shows now; null if it is gone. */
  function ddShown(o) {
    const d = o.doc === docToken ? refs.get(o.ref)?.deref() : null;
    if (!d || !d.isConnected) return { gone: true };
    return { shown: shownValue(d), expanded: d.getAttribute('aria-expanded') === 'true' };
  }

  /** Option-like elements visible anywhere now (for "click the right one yourself"). */
  function visibleOptions(o) {
    const opts = optionsIn(document.body || document.documentElement, []);
    return { total: opts.length, lines: opts.slice(0, o.limit || 30).map((x) => candidate(x, 0)) };
  }

  // ---- full capture of a scrolling element ------------------------------------------------------
  /** Sticky or fixed things inside the box at its top and bottom edges: { top, bottom } in px. */
  function edgeBars(el, box) {
    let top = 0;
    let bottom = 0;
    const xs = [0.1, 0.5, 0.9].map((f) => box.left + box.width * f);
    for (const [y, atTop] of box.cut ? [[box.top + 1, true]] : [[box.top + 1, true], [box.top + box.height - 2, false]]) {
      for (const x of xs) {
        for (const h of document.elementsFromPoint(x, y)) {
          if (h === el || !composedContains(el, h)) continue;
          for (let p = h; p && p !== el; p = parentOf(p)) {
            const pos = getComputedStyle(p).position;
            if (pos !== 'sticky' && pos !== 'fixed') continue;
            const r = p.getBoundingClientRect();
            if (atTop && r.top <= box.top + 1) top = Math.max(top, r.bottom - box.top);
            if (!atTop && r.bottom >= box.top + box.height - 1) bottom = Math.max(bottom, box.top + box.height - r.top);
          }
        }
      }
    }
    // A bar taller than 40% of the box is not a bar.
    const cap = box.height * 0.4;
    return { top: Math.min(Math.max(0, Math.ceil(top)), cap), bottom: Math.min(Math.max(0, Math.ceil(bottom)), cap) };
  }

  /**
   * The element's scrollport in viewport px, cut to the viewport (only what is on screen can be
   * captured without changing the layout). cut: its bottom is below the viewport.
   */
  function scrollBox(el) {
    const r = el.getBoundingClientRect();
    const left = Math.max(0, r.left + el.clientLeft);
    const top = Math.max(0, r.top + el.clientTop);
    const right = Math.min(vw(), r.left + el.clientLeft + el.clientWidth);
    const bottom = Math.min(vh(), r.top + el.clientTop + el.clientHeight);
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top), cut: bottom < r.top + el.clientTop + el.clientHeight - 1 };
  }

  function scrollerInfo(o) {
    const el = resolve(o);
    if (el.__error) return el;
    const se = document.scrollingElement || document.documentElement;
    if (el === se || el === document.body || el === document.documentElement) {
      return ERR('bad_args', 'That is the page itself: use screenshot with full_page: true and no element.');
    }
    const cs = getComputedStyle(el);
    if (!(SCROLLS.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1)) {
      return ERR('bad_args', `${label(el)} does not scroll vertically (its content fits). Screenshot it without full_page, or pass the element that scrolls.`);
    }
    if (!(el.clientWidth > 0 && el.clientHeight > 0)) return ERR('no_element', `${label(el)} has no visible area.`);
    // Its top edge must be on screen: rows above the viewport could never be captured.
    const r = el.getBoundingClientRect();
    let moved = false;
    if (r.top < 0 || r.top >= vh() || r.left < 0 || r.left >= vw()) {
      try { el.scrollIntoView({ block: 'start', inline: 'start', behavior: 'instant' }); } catch { el.scrollIntoView(true); }
      moved = true;
    }
    const box = scrollBox(el);
    if (box.width < 1 || box.height < 1) return ERR('no_element', `${tagDesc(el)} could not be scrolled into the viewport.`);
    return { ref: ref(el), desc: tagDesc(el), top: el.scrollTop, height: el.scrollHeight, moved, doc: docToken };
  }

  /** Scroll the element to `top` and report where it really is, its box, and its edge bars. */
  function scrollerStep(o) {
    const el = resolve({ ref: o.ref, doc: o.doc });
    if (el.__error) return el;
    try { el.scrollTo({ top: o.top, behavior: 'instant' }); } catch { el.scrollTop = o.top; }
    const box = scrollBox(el);
    return {
      top: el.scrollTop, height: el.scrollHeight, box, bars: edgeBars(el, box),
      scrollX: window.scrollX, scrollY: window.scrollY, doc: docToken,
    };
  }

  /** Put the scroll position back, unless someone else moved it meanwhile. */
  function scrollerRestore(o) {
    const el = o.doc === docToken ? refs.get(o.ref)?.deref() : null;
    if (!el || !el.isConnected) return false;
    if (Math.abs(el.scrollTop - o.expect) > 2) return false;
    try { el.scrollTo({ top: o.top, behavior: 'instant' }); } catch { el.scrollTop = o.top; }
    return true;
  }

  /** The element the page's content scrolls in, when the page itself doesn't scroll. */
  function mainScroller() {
    const best = { el: null, area: 0 };
    const seen = new Set();
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.6], [0.7, 0.6], [0.5, 0.8]]) {
      for (let p = deepElementFromPoint(vw() * fx, vh() * fy); p && p !== document.body && p !== document.documentElement; p = parentOf(p)) {
        if (seen.has(p)) continue;
        seen.add(p);
        const cs = getComputedStyle(p);
        if (!(SCROLLS.test(cs.overflowY) && cs.overflowY !== 'hidden' && p.scrollHeight > p.clientHeight + 1)) continue;
        const area = p.clientWidth * p.clientHeight;
        if (area > best.area) { best.el = p; best.area = area; }
      }
    }
    if (!best.el || best.area < vw() * vh() * 0.3) return null;
    return { ref: ref(best.el), desc: tagDesc(best.el), height: best.el.scrollHeight };
  }

  // ---- wait_for --------------------------------------------------------------------------------
  function waitCheck(o) {
    let found = false;
    let desc = '';
    if (o.selector) {
      let list;
      try { list = document.querySelectorAll(o.selector); } catch (e) {
        return ERR('bad_args', `Invalid CSS selector ${JSON.stringify(o.selector)}: ${e.message}`);
      }
      for (const el of list) {
        // Visible text only: a hidden "Ready" inside a visible box doesn't count.
        if (rendered(el) && (!o.text || (el.innerText || '').includes(o.text))) {
          found = true;
          desc = `[${ref(el)}] ${label(el)}`;
          break;
        }
      }
    } else {
      found = (document.body ? document.body.innerText : document.documentElement.textContent || '').includes(o.text);
    }
    return { found, desc, ready: document.readyState, doc: docToken };
  }

  /** The element the text was found in (innermost), for the wait_for result. */
  function locateText(o) {
    if (o.doc != null && o.doc !== docToken) return { desc: '' };
    const ms = textMatches(o.text);
    if (ms.__error || !ms.length) return { desc: '' };
    const more = ms.length > 1 ? ` (and ${ms.length - 1} more place${ms.length > 2 ? 's' : ''})` : '';
    return { desc: `[${ref(ms[0].el)}] ${label(ms[0].el)}${more}` };
  }

  // ---- scrolling -------------------------------------------------------------------------------
  function scrollableAncestor(el) {
    const se = document.scrollingElement || document.documentElement;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement || n.getRootNode().host) {
      if (n === se || n === document.body) return null;
      const cs = getComputedStyle(n);
      const oy = /(auto|scroll|overlay)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1;
      const ox = /(auto|scroll|overlay)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1;
      if (oy || ox) return n;
    }
    return null;
  }

  function scrollState(o) {
    const se = document.scrollingElement || document.documentElement;
    const out = {
      page: {
        x: Math.round(window.scrollX), y: Math.round(window.scrollY),
        maxX: Math.max(0, se.scrollWidth - se.clientWidth), maxY: Math.max(0, se.scrollHeight - se.clientHeight),
        vw: vw(), vh: vh(),
      },
      inner: null,
    };
    if (o && o.x != null) {
      const hit = deepElementFromPoint(o.x, o.y);
      const sc = hit && scrollableAncestor(hit);
      if (sc) {
        out.inner = {
          desc: shortDesc(sc).split(' ')[0],
          top: Math.round(sc.scrollTop), left: Math.round(sc.scrollLeft),
          maxTop: sc.scrollHeight - sc.clientHeight, maxLeft: sc.scrollWidth - sc.clientWidth,
        };
      }
    }
    return out;
  }

  function scrollTo(o) {
    const el = resolve(o);
    if (el.__error) return el;
    scrollIntoViewCentered(el);
    const r = el.getBoundingClientRect();
    return { desc: label(el), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  /** Fallback when a synthetic wheel event did not scroll anything. */
  function scrollByJs(o) {
    const hit = deepElementFromPoint(o.x, o.y);
    const target = (hit && scrollableAncestor(hit)) || document.scrollingElement || document.documentElement;
    try { target.scrollBy({ left: o.dx, top: o.dy, behavior: 'instant' }); } catch { target.scrollBy(o.dx, o.dy); }
    return true;
  }

  return {
    readText, interactive, html, find, point, at, elementRect, metrics, scrollPageTo,
    focus, active, selectAllInFocused, focusedLength, forceClear, selectOption,
    ddTarget, ddOptions, ddPick, ddFinal, ddShown, visibleOptions,
    scrollerInfo, scrollerStep, scrollerRestore, mainScroller,
    waitCheck, locateText,
    scrollState, scrollTo, scrollByJs,
  };
}

/**
 * Function declaration for Runtime.callFunctionOn(executionContextId = the cctether world).
 * Installs the library on first use (per document) and calls one of its functions.
 */
export const LIB_CALL = `function (name, args) {
  let lib = globalThis.__cctether;
  if (!lib) {
    lib = (${cctetherPageLib.toString()})();
    Object.defineProperty(globalThis, '__cctether', { value: lib, enumerable: false });
  }
  return lib[name](...args);
}`;

/**
 * Turns the result of the evaluate tool into JSON text. Called with Runtime.callFunctionOn on the
 * result object (so it runs in that object's world). `this` is the value.
 */
export const SERIALIZE_FN = `function (maxNodes) {
  let budget = maxNodes || 20000;
  const seen = new WeakSet();
  const isNode = (v) => typeof Node === 'function' && v instanceof Node;
  function nodeDesc(n) {
    if (n.nodeType === 9) return '#document';
    if (n.nodeType === 3) return '#text ' + JSON.stringify(String(n.data).slice(0, 80));
    if (n.nodeType !== 1) return n.nodeName;
    let s = '<' + n.localName;
    if (n.id) s += '#' + n.id;
    if (n.classList && n.classList.length) s += '.' + [...n.classList].slice(0, 3).join('.');
    return s + '>';
  }
  function ser(v, depth) {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'number') return Number.isFinite(v) ? v : String(v);
    if (t === 'bigint') return v.toString() + 'n';
    if (t === 'undefined') return undefined;
    if (t === 'symbol') return v.toString();
    if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
    if (seen.has(v)) return '[Circular]';
    if (--budget < 0) return '[…]';
    try {
      if (isNode(v)) return nodeDesc(v);
      if (typeof Window === 'function' && v instanceof Window) return '[Window]';
      if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
      if (v instanceof RegExp) return String(v);
      if (v instanceof Error) return { name: v.name, message: v.message, stack: String(v.stack || '').split('\\n').slice(0, 6).join('\\n') };
      if (typeof Promise === 'function' && v instanceof Promise) return '[Promise]';
      if (depth > 8) return Array.isArray(v) ? '[Array(' + v.length + ')]' : '[Object]';
      seen.add(v);
      if (v instanceof Map) return { '[Map]': [...v].slice(0, 500).map(([k, x]) => [ser(k, depth + 1), ser(x, depth + 1)]) };
      if (v instanceof Set) return { '[Set]': [...v].slice(0, 500).map((x) => ser(x, depth + 1)) };
      if (ArrayBuffer.isView(v)) return Array.from(v.subarray ? v.subarray(0, 1000) : []);
      if (Array.isArray(v) || (typeof NodeList === 'function' && v instanceof NodeList) || (typeof HTMLCollection === 'function' && v instanceof HTMLCollection)) {
        const out = [];
        const n = Math.min(v.length, 1000);
        for (let i = 0; i < n; i++) { const x = ser(v[i], depth + 1); out.push(x === undefined ? null : x); }
        if (v.length > n) out.push('… ' + (v.length - n) + ' more');
        return out;
      }
      if (typeof v.toJSON === 'function') { try { return ser(v.toJSON(), depth + 1); } catch (e) { /* fall through */ } }
      const out = {};
      const keys = Object.keys(v);
      for (const k of keys.slice(0, 500)) {
        let x;
        try { x = ser(v[k], depth + 1); } catch (e) { x = '[Threw: ' + (e && e.message) + ']'; }
        if (x !== undefined) out[k] = x;
      }
      if (keys.length > 500) out['…'] = (keys.length - 500) + ' more keys';
      return out;
    } catch (e) {
      return '[Unserializable: ' + (e && e.message) + ']';
    }
  }
  const r = ser(this, 0);
  return r === undefined ? 'undefined' : JSON.stringify(r);
}`;

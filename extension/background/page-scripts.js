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

  const ERR = (code, message) => ({ __error: { code, message } });
  const AGAIN = 'Call read_page (mode "interactive") or find again to get fresh numbers.';

  function resolve(t) {
    if (t && t.ref != null) {
      const el = refs.get(t.ref)?.deref();
      if (!el) {
        return ERR('stale_ref', `Element ${t.ref} is not known on the current page (numbers are reset when the page navigates or reloads). ${AGAIN}`);
      }
      if (!el.isConnected) return ERR('stale_ref', `Element ${t.ref} has been removed from the page. ${AGAIN}`);
      return el;
    }
    if (t && t.selector != null) {
      let el;
      try { el = document.querySelector(t.selector); } catch (e) {
        return ERR('bad_args', `Invalid CSS selector ${JSON.stringify(t.selector)}: ${e.message}`);
      }
      if (!el) return ERR('no_element', `No element matches the selector ${JSON.stringify(t.selector)}. Check it with find, or use wait_for if it appears later.`);
      return el;
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

  function valueText(el) {
    if (el.localName === 'input' && el.type === 'password') return el.value ? `(${el.value.length} characters, hidden)` : '';
    if ('value' in el && (el.localName === 'input' || el.localName === 'textarea')) return el.value;
    const host = editingHost(el);
    if (host) return host.innerText;
    return null;
  }

  function line(el, kind) {
    const parts = [`[${ref(el)}] ${kind}`];
    const name = accName(el);
    if (name) parts.push(JSON.stringify(clip(name, 80)));
    const tag = el.localName;
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
    const w = where(el.getBoundingClientRect());
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

  function interactive(o) {
    const root = rootOf(o.selector);
    if (root.__error) return root;
    const max = o.max || 3000;
    const lines = [];
    let total = 0;
    // Iterative DFS in document order, piercing open shadow roots. `inside` = an ancestor is
    // already listed (then cursor:pointer alone doesn't make a descendant interesting).
    const stack = [[root, false]];
    while (stack.length) {
      const [node, inside] = stack.pop();
      let listed = false;
      if (node.nodeType === 1) {
        let kind = kindOf(node);
        if (!kind && !inside && node !== document.body && node !== document.documentElement) {
          const cs = getComputedStyle(node);
          if (cs.cursor === 'pointer' && (!node.parentElement || getComputedStyle(node.parentElement).cursor !== 'pointer')) kind = 'clickable';
        }
        if (kind && rendered(node)) {
          total++;
          if (lines.length < max) lines.push(line(node, kind));
          listed = true;
        }
        if (node.localName === 'select' || node.localName === 'iframe') continue;
      }
      const kids = [];
      if (node.shadowRoot) kids.push(...node.shadowRoot.children);
      kids.push(...node.children);
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], inside || listed]);
    }
    return { title: document.title, url: location.href, lines, total, vw: vw(), vh: vh() };
  }

  function html(o) {
    const root = o.selector ? resolve({ selector: o.selector }) : (document.body || document.documentElement);
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
    try { list = document.querySelectorAll(o.selector); } catch (e) {
      return ERR('bad_args', `Invalid CSS selector ${JSON.stringify(o.selector)}: ${e.message}`);
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
      });
    }
    return { count: list.length, items };
  }

  // ---- pointer targets -------------------------------------------------------------------------
  /** Scroll the element into view and pick the point a user would click. */
  function point(o) {
    const el = resolve(o);
    if (el.__error) return el;
    if (!fullyVisible(el.getBoundingClientRect())) scrollIntoViewCentered(el);
    const rects = [...el.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
    if (!rects.length || !rendered(el)) {
      return ERR('no_element', `${label(el)} is not visible (hidden or zero size). Check it with find, or wait_for it to appear.`);
    }
    const W = vw();
    const H = vh();
    const rr = rects.find((x) => x.bottom > 0 && x.right > 0 && x.top < H && x.left < W) || rects[0];
    const left = Math.max(rr.left, 0);
    const right = Math.min(rr.right, W);
    const top = Math.max(rr.top, 0);
    const bottom = Math.min(rr.bottom, H);
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
    return { x, y, desc: label(el), covered };
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
    };
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
    const el = resolve(o);
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
        if (rendered(el) && (!o.text || (el.innerText || el.textContent || '').includes(o.text))) {
          found = true;
          desc = `[${ref(el)}] ${label(el)}`;
          break;
        }
      }
    } else {
      found = (document.body ? document.body.innerText : document.documentElement.textContent || '').includes(o.text);
    }
    return { found, desc, ready: document.readyState };
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
    readText, interactive, html, find, point, at, elementRect, metrics,
    focus, active, selectAllInFocused, focusedLength, forceClear, selectOption, waitCheck,
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

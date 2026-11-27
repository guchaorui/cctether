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
  // Elements of same-origin frames get numbers from the same map. Each number remembers the
  // document its element was in: when the frame navigates, or the element is moved to another
  // document, the number is stale (an element of an old document can still be "connected").
  const refs = new Map(); // number -> { el: WeakRef<Element>, doc: WeakRef<Document> }
  const refOf = new WeakMap(); // Element -> number
  let nextRef = 1;

  function ref(el) {
    const n = refOf.get(el);
    if (n && refs.get(n)?.el.deref() === el && refs.get(n).doc.deref() === el.ownerDocument) return n;
    const m = nextRef++;
    refs.set(m, { el: new WeakRef(el), doc: new WeakRef(el.ownerDocument) });
    refOf.set(el, m);
    return m;
  }

  /** The element number n stands for, if it is still where it was (else null). */
  function refEl(n) {
    const e = refs.get(n);
    const el = e?.el.deref();
    if (!el || !el.isConnected || el.ownerDocument !== e.doc.deref() || !docLive(el.ownerDocument)) return null;
    return el;
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
      if (!refs.get(t.ref)?.el.deref()) {
        return ERR('stale_ref', `Element ${t.ref} is not known on the current page (numbers are reset when the page navigates or reloads). ${AGAIN}`);
      }
      const el = refEl(t.ref);
      if (!el) return ERR('stale_ref', `Element ${t.ref} has been removed from the page (or the frame it was in has navigated). ${AGAIN}`);
      return el;
    }
    if (t && t.text != null) return byText(t.text, t.selector);
    if (t && t.selector != null) return bySelector(t.selector, firstMatch);
    return ERR('bad_args', 'Pass ref or selector to say which element.');
  }

  function queryAll(root, selector) {
    try { return root.querySelectorAll(selector); } catch (e) {
      return ERR('bad_args', `Invalid CSS selector ${JSON.stringify(selector)}: ${e.message}`);
    }
  }

  /**
   * The element a selector means: in the page itself if anything there matches (as always);
   * otherwise in the one same-origin frame where something matches. Matches in several frames:
   * refused, with candidates (two forms side by side may both have #create).
   */
  function bySelector(selector, firstMatch) {
    const pick = (list) => {
      if (!firstMatch) for (const el of list) if (rendered(el)) return el;
      return list[0];
    };
    const top = queryAll(document, selector);
    if (top.__error) return top;
    if (top.length) return pick(top);
    const hits = [];
    for (const d of frameDocs()) {
      const l = queryAll(d, selector);
      if (l.length) hits.push(l);
    }
    if (hits.length === 1) return pick(hits[0]);
    if (hits.length > 1) {
      return ERR('ambiguous', `Nothing in the page itself matches the selector ${JSON.stringify(selector)}, but elements in ${hits.length} of its frames (iframes) do, so cctether did not pick one. Pass the ref of the right one:`,
        hits.slice(0, 10).map((l) => candidate(pick(l), 0)));
    }
    return ERR('no_element', `No element matches the selector ${JSON.stringify(selector)}. Check it with find, or use wait_for if it appears later.${blindNote()}`);
  }

  /** The element itself, or for a frame cctether can reach, its document's body. */
  function frameRoot(el) {
    if (isFrameEl(el)) {
      const d = frameDoc(el);
      if (d) return d.body || d.documentElement;
    }
    return el;
  }

  function rootOf(selector) {
    if (!selector) return document.body || document.documentElement;
    const el = resolve({ selector });
    return el.__error ? el : frameRoot(el);
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

  // ---- same-origin frames (SPEC §5.2) -----------------------------------------------------------
  // Frames whose document can be reached from here (same origin, srcdoc, about:blank...) are
  // searched and listed like the page itself; the others are described as such, never guessed at.
  // Positions given to Claude and points pressed are always in the top viewport's CSS px.
  const MAX_FRAMES = 20;
  const MAX_DEPTH = 5;
  const INF = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
  let cache = {}; // for one library call (cleared after each, see the end)

  const isFrameEl = (el) => !!el && el.nodeType === 1 && (el.localName === 'iframe' || el.localName === 'frame');

  /** The document shown in a frame element, if cctether can reach it; else null. */
  function frameDoc(fe) {
    try {
      const d = fe.contentDocument;
      return d && d.documentElement ? d : null;
    } catch { return null; }
  }

  /** The frame element a document other than the page's is shown in, else null. */
  function hostFrame(d) {
    if (!d || d === document) return null;
    try { return d.defaultView?.frameElement || null; } catch { return null; }
  }

  /** The page's document, or the current document of a frame that is itself still live. */
  function docLive(d) {
    for (let i = 0; d !== document; i++) {
      const fe = hostFrame(d);
      if (!fe || i > MAX_DEPTH || !fe.isConnected || frameDoc(fe) !== d) return false;
      d = fe.ownerDocument;
    }
    return true;
  }

  /** Frame elements inside root (a document, shadow root or element), open shadow roots too. */
  function frameEls(root) {
    const out = [];
    let n = 0;
    const walk = (r) => {
      for (const el of r.querySelectorAll('*')) {
        if (++n > 50000) return;
        if (isFrameEl(el)) out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out;
  }

  /**
   * Rendered frames (at least 4×4 px) in document order, each followed by those inside it:
   * [{ el, doc (null: cctether can't reach it) }]. At most MAX_FRAMES, MAX_DEPTH deep.
   */
  function frames() {
    if (cache.frames) return cache.frames;
    const out = [];
    const walk = (root, depth) => {
      for (const fe of frameEls(root)) {
        if (out.length >= MAX_FRAMES) { cache.capped = true; return; }
        if (!rendered(fe)) continue;
        const r = fe.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const doc = frameDoc(fe);
        out.push({ el: fe, doc });
        if (doc && depth < MAX_DEPTH) walk(doc, depth + 1);
      }
    };
    walk(document, 1);
    cache.frames = out;
    return out;
  }
  const frameDocs = () => frames().filter((f) => f.doc).map((f) => f.doc);
  const allDocs = () => [document, ...frameDocs()];
  const reachable = (fe) => frames().some((f) => f.el === fe && f.doc);

  /** ' (N frames … can't be searched)' when the page has frames cctether can't look into. */
  function blindNote() {
    const n = frames().filter((f) => !f.doc).length;
    return n ? ` (${n === 1 ? 'One frame' : `${n} frames`} on the page can't be searched: another site's, or sandboxed.)` : '';
  }

  /** 'frame "Workload"' (or 'a frame'): how results name a frame. */
  function frameName(fe) {
    const n = clip(norm(fe.title || fe.name || fe.getAttribute('aria-label') || ''), 60);
    return n ? `frame ${JSON.stringify(n)}` : 'a frame';
  }
  /** ' in frame "Workload"' for an element in a frame, else ''. */
  const inFrame = (el) => {
    const fe = el && hostFrame(el.ownerDocument);
    return fe ? ` in ${frameName(fe)}` : '';
  };

  /**
   * The address a frame declares, shortened: http(s) as origin and path (query, fragment and
   * credentials dropped: they may hold tokens), other kinds by name only. { text, open: the
   * address to suggest for open_tab, or null }.
   */
  function frameSrc(fe) {
    if (fe.hasAttribute('srcdoc')) return { text: 'inline content (srcdoc)', open: null };
    const raw = (fe.getAttribute('src') || '').trim();
    if (!raw) return { text: '', open: null };
    let u;
    try { u = new URL(raw, fe.ownerDocument.baseURI); } catch { return { text: 'an invalid address', open: null }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { text: `a ${u.protocol.slice(0, -1).slice(0, 20)}: address`, open: null };
    const open = clip(u.origin + u.pathname, 150);
    const more = u.search || u.hash ? '?…' : '';
    return { text: (u.origin === location.origin ? clip(u.pathname, 120) : open) + more, open };
  }

  /** 'frame "Workload" → /app/form (1200×800)' */
  function frameLine(fe) {
    const src = frameSrc(fe).text;
    const b = contentBox(fe);
    return `${frameName(fe)}${src ? ` → ${src}` : ''} (${Math.round(b.right - b.left)}×${Math.round(b.bottom - b.top)})`;
  }

  /** Does el, or an element around it in its document, rotate, scale, flip or zoom it? */
  function transformed(el) {
    for (let p = el, i = 0; p && i < 300; p = parentOf(p), i++) {
      const cs = getComputedStyle(p);
      if ((cs.rotate && cs.rotate !== 'none') || (cs.scale && cs.scale !== 'none')) return true;
      if (cs.zoom && cs.zoom !== '1' && cs.zoom !== 'normal') return true;
      const t = cs.transform;
      if (t && t !== 'none') {
        const m = /^matrix\(([^)]*)\)$/.exec(t);
        if (!m) return true; // matrix3d
        const [a, b, c, d] = m[1].split(',').map(Number);
        if (Math.abs(a - 1) > 1e-6 || Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6 || Math.abs(d - 1) > 1e-6) return true;
      }
    }
    return false;
  }

  /** Can positions in document d be turned into page positions (nothing but moves on the way)? */
  function plainDoc(d) {
    if (d === document) return true;
    cache.plain ??= new Map();
    if (!cache.plain.has(d)) {
      let ok = true;
      for (let cur = d, i = 0; cur !== document; i++) {
        const fe = hostFrame(cur);
        if (!fe || i > MAX_DEPTH || transformed(fe)) { ok = false; break; }
        cur = fe.ownerDocument;
      }
      cache.plain.set(d, ok);
    }
    return cache.plain.get(d);
  }

  const transformedError = (el) => ERR('no_element', `${labelIn(el)} is in a frame that is rotated, scaled or zoomed (CSS), so cctether can't tell where it is on the screen. Use evaluate to work with it.`);

  /** Where a frame element shows its document (its content box), in its own document's px. */
  function contentBox(fe) {
    const r = fe.getBoundingClientRect();
    const cs = getComputedStyle(fe);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const left = r.left + fe.clientLeft + pl;
    const top = r.top + fe.clientTop + pt;
    const w = fe.clientWidth - pl - (parseFloat(cs.paddingRight) || 0);
    const h = fe.clientHeight - pt - (parseFloat(cs.paddingBottom) || 0);
    return { left, top, right: left + Math.max(0, w), bottom: top + Math.max(0, h) };
  }

  const shift = (r, o) => ({ left: r.left + o.x, top: r.top + o.y, right: r.right + o.x, bottom: r.bottom + o.y, width: r.right - r.left, height: r.bottom - r.top });
  const meet = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const viewport = () => ({ left: 0, top: 0, right: vw(), bottom: vh() });

  /** Where document d's viewport is in the page's viewport: { x, y }. */
  function docOffset(d) {
    if (d === document) return { x: 0, y: 0 };
    cache.offsets ??= new Map();
    if (!cache.offsets.has(d)) {
      let x = 0;
      let y = 0;
      for (let cur = d, i = 0; cur !== document && i <= MAX_DEPTH; i++) {
        const fe = hostFrame(cur);
        if (!fe) break;
        const b = contentBox(fe);
        x += b.left;
        y += b.top;
        cur = fe.ownerDocument;
      }
      cache.offsets.set(d, { x, y });
    }
    return cache.offsets.get(d);
  }

  /** el's bounding box in the page's viewport. */
  const topRect = (el) => shift(el.getBoundingClientRect(), docOffset(el.ownerDocument));

  /**
   * The part of the page's viewport where document d can be seen: inside every frame it is in,
   * and inside the scrolling boxes around those frames.
   */
  function docClip(d) {
    let c = viewport();
    for (let cur = d, i = 0; cur !== document && i <= MAX_DEPTH; i++) {
      const fe = hostFrame(cur);
      if (!fe) break;
      const o = docOffset(fe.ownerDocument);
      c = meet(c, shift(contentBox(fe), o));
      c = meet(c, shift(clipBy(scrollers(fe), INF), o));
      cur = fe.ownerDocument;
    }
    return c;
  }

  /** '' if (part of) el is where its document can be seen, else an arrow saying where it is. */
  function where(el) {
    const r = topRect(el);
    const c = el.ownerDocument === document ? viewport() : docClip(el.ownerDocument);
    if (r.bottom <= c.top) return '↑';
    if (r.top >= c.bottom) return '↓';
    if (r.right <= c.left) return '←';
    if (r.left >= c.right) return '→';
    return '';
  }

  function fullyVisible(el) {
    const r = topRect(el);
    const c = el.ownerDocument === document ? viewport() : docClip(el.ownerDocument);
    return r.top >= c.top && r.left >= c.left && r.bottom <= c.bottom && r.right <= c.right;
  }

  /**
   * Scroll el into view (block: 'center' or 'start'). For an element in a frame, the documents
   * around the frame (and the boxes around the frame in them) are put back where they were if el
   * can be seen as well that way: scrollIntoView moves them too, even a page the user can't
   * scroll (on a console shell whose frame was a few px too tall, its header moved up 6 px).
   */
  function scrollIntoViewCentered(el, block = 'center') {
    const outer = []; // [window, x, y, [[box, left, top]...]] for each document around el's frames
    for (let d = el.ownerDocument, i = 0; d !== document && i <= MAX_DEPTH; i++) {
      const fe = hostFrame(d);
      if (!fe) break;
      const w = fe.ownerDocument.defaultView;
      outer.push([w, w.scrollX, w.scrollY, scrollers(fe).map((b) => [b.el, b.el.scrollLeft, b.el.scrollTop])]);
      d = fe.ownerDocument;
    }
    try {
      el.scrollIntoView({ block, inline: block, behavior: 'instant' });
    } catch {
      el.scrollIntoView({ block, inline: block });
    }
    cache.offsets = null; // positions worked out before this are out of date now
    if (!outer.length) return;
    const now = outer.map(([w, , , boxes]) => [w, w.scrollX, w.scrollY, boxes.map(([b]) => [b, b.scrollLeft, b.scrollTop])]);
    const put = (list) => {
      for (const [w, x, y, boxes] of list) {
        for (const [b, left, top] of boxes) { b.scrollLeft = left; b.scrollTop = top; }
        try { w.scrollTo({ left: x, top: y, behavior: 'instant' }); } catch { w.scrollTo(x, y); }
      }
      cache.offsets = null;
    };
    const seen = () => {
      const m = meet(topRect(el), docClip(el.ownerDocument));
      return Math.max(0, m.right - m.left) * Math.max(0, m.bottom - m.top);
    };
    const moved = seen();
    put(outer);
    if (seen() + 1 < moved) put(now); // the frame itself had to move for el to be seen
  }

  /** The node above n: its parent, a shadow root's host, or the frame element a document is in. */
  const upNode = (n) => (n.nodeType === 9 ? hostFrame(n) : n.parentNode || n.host || null);

  /** Is node inside ancestor, counting shadow roots and frames? */
  function composedContains(ancestor, node) {
    for (let n = node, i = 0; n && i < 5000; n = upNode(n), i++) if (n === ancestor) return true;
    return false;
  }

  /** Parent element, stepping out of a shadow root to its host. */
  const parentOf = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  /** parentOf, also stepping out of a frame's document to the frame element. */
  const parentX = (el) => parentOf(el) || (el === el.ownerDocument.documentElement ? hostFrame(el.ownerDocument) : null);
  const isRootEl = (el) => el === el.ownerDocument.body || el === el.ownerDocument.documentElement;

  /** Element children, including those of an open shadow root. */
  function kidsOf(node) {
    return node.shadowRoot ? [...node.shadowRoot.children, ...node.children] : [...node.children];
  }

  const SCROLLS = /(auto|scroll|overlay|hidden)/;

  /** Ancestors that scroll (or clip and can be scrolled by script) in either direction. */
  function scrollers(el) {
    const out = [];
    for (let p = parentOf(el), i = 0; p && i < 60; p = parentOf(p), i++) {
      if (isRootEl(p)) break;
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

  /**
   * The element on top at a viewport point, inside open shadow roots and inside the frames
   * cctether can reach (only within a frame's content box: on its border it is the frame
   * element). { el, frames: the frame elements entered, outermost first }.
   */
  function deepHit(x, y) {
    let root = document;
    let lx = x;
    let ly = y;
    const entered = [];
    for (;;) {
      let h = root.elementFromPoint(lx, ly);
      while (h && h.shadowRoot) {
        const inner = h.shadowRoot.elementFromPoint(lx, ly);
        if (!inner || inner === h) break;
        h = inner;
      }
      if (!isFrameEl(h) || entered.length >= MAX_DEPTH) return { el: h, frames: entered };
      const d = frameDoc(h);
      if (!d || transformed(h)) return { el: h, frames: entered };
      const b = contentBox(h);
      if (lx < b.left || ly < b.top || lx >= b.right || ly >= b.bottom) return { el: h, frames: entered };
      entered.push(h);
      lx -= b.left;
      ly -= b.top;
      root = d;
    }
  }
  const deepElementFromPoint = (x, y) => deepHit(x, y).el;
  /** The element on top at a viewport point in the page itself (inside shadow roots, not frames). */
  function pageElementFromPoint(x, y) {
    let h = document.elementFromPoint(x, y);
    while (h && h.shadowRoot) {
      const inner = h.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === h) break;
      h = inner;
    }
    return h;
  }

  /** The focused element, inside shadow roots and frames cctether can reach. */
  function deepActive() {
    let a = document.activeElement;
    for (let i = 0; a && i < 50; i++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (isFrameEl(a)) {
        const d = frameDoc(a);
        if (d && d.activeElement) { a = d.activeElement; continue; }
      }
      break;
    }
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
    if (el.id) s += `#${clip(norm(el.id), 30)}`;
    const cls = [...(el.classList || [])].slice(0, 2).map((c) => clip(c, 30));
    if (cls.length) s += `.${cls.join('.')}`;
    const name = norm(el.getAttribute('aria-label') || '');
    return name ? `${s} ${JSON.stringify(clip(name, 40))}` : s;
  }

  function shortDesc(el) {
    if (!el) return 'nothing';
    let s = el.localName || '#node';
    if (el.id) s += `#${clip(norm(el.id), 30)}`;
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
      const n = (root.getElementById ? root.getElementById(id) : null) || el.ownerDocument.getElementById(id);
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
  /** label(), saying which frame the element is in, if it is in one. */
  const labelIn = (el) => label(el) + inFrame(el);

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
  function textMatches(text, selector, docs = null) {
    const needle = norm(text);
    if (!needle) return ERR('bad_args', '`text` is empty.');
    const low = needle.toLowerCase();
    const found = new Map(); // Element -> best tier, in the order found
    const add = (el, tier) => {
      if (tier < 0 || isRootEl(el)) return;
      const had = found.get(el);
      if (had === undefined || tier < had) found.set(el, tier);
    };
    if (selector != null) {
      let n = 0;
      for (const d of docs || allDocs()) {
        const list = queryAll(d, selector);
        if (list.__error) return list;
        for (const el of list) {
          if (++n > 5000) break;
          if (!rendered(el)) continue;
          add(el, tierOf(norm(el.innerText || ''), needle, low));
          add(el, bestTier([accName(el), ...attrNames(el)].map((x) => tierOf(x, needle, low))));
        }
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
      // The page first, then the frames cctether can reach.
      for (const d of docs || allDocs()) {
        const top = d.body || d.documentElement;
        if (top) walk(top);
      }
    }
    return [...found].map(([el, tier]) => ({ el, tier })).sort((a, b) => a.tier - b.tier);
  }

  /** The nearest link, button, option... (or label of a control) around el with the same visible text, else el. */
  function lift(el, own) {
    if (kindOf(el) || (el.localName === 'label' && labelled(el))) return el;
    let p = parentOf(el);
    for (let i = 0; p && i < 6; i++, p = parentOf(p)) {
      if (isRootEl(p)) break;
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
    const r = topRect(el);
    let s = `[${ref(el)}] ${labelIn(el)} at (${Math.round(r.left + r.width / 2)}, ${Math.round(r.top + r.height / 2)})`;
    const w = where(el);
    if (w) s += ` ${w}`;
    // Some context to tell look-alikes apart, e.g. the table row an "Edit" button is in.
    const own = norm(el.innerText || accName(el));
    for (let p = parentOf(el), i = 0; p && i < 4; p = parentOf(p), i++) {
      if (p === el.ownerDocument.body) break;
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
    // Exact matches in more than one document (the page and a frame, or two frames): which one is
    // meant can't be told by the usual preferences (exact case, a button over a heading), which
    // only compare elements of one document.
    const exact = oneOfLabelled(all.filter((m) => m.tier <= 1));
    const docs = new Set(exact.map((m) => m.el.ownerDocument));
    if (docs.size > 1) {
      const places = docs.has(document) ? `the page and ${docs.size - 1} of its frames (iframes)` : `${docs.size} frames (iframes)`;
      return ERR('ambiguous', `Elements${scope} in ${places} have the text ${want}, so cctether did not pick one. Pass the ref of the right one:`, candidates(exact));
    }
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
    return ERR('no_element', `No visible element${scope} has the text ${want}. Check the page with read_page or screenshot, or use wait_for if it appears later.${blindNote()}`);
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
      // Only frames cctether can't look into are listed (the others are entered).
      const src = frameSrc(el).text;
      if (src) parts.push(`→ ${src}`);
      parts.push(frameDoc(el) ? '(not searched: too many frames)' : "(cctether can't see inside: another site's, or sandboxed)");
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
    const w = where(at);
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
    let text = tidy(root.innerText ?? root.textContent ?? '');
    // Then each frame inside it, in order: its text, or why it can't be read.
    const parts = [];
    let n = 0;
    let blind = 0;
    for (const f of frames()) {
      if (!composedContains(root, f.el)) continue;
      if (f.doc) {
        n++;
        const body = f.doc.body || f.doc.documentElement;
        parts.push(`── ${frameLine(f.el)} ──\n${tidy(body.innerText ?? body.textContent ?? '') || '(no visible text)'}`);
      } else {
        blind++;
        const { open } = frameSrc(f.el);
        parts.push(`── ${frameLine(f.el)}: cctether can't read inside it (another site's, or sandboxed).${open ? ' Its declared address can be opened on its own with open_tab, but it may not work the same there.' : ''} ──`);
      }
    }
    if (parts.length) text = [text || '(no visible text in the page itself)', ...parts].join('\n\n');
    return { title: document.title, url: location.href, text, frames: n, blind, capped: !!cache.capped };
  }

  /**
   * Can a user (and a click at its centre) reach this control? Not when it is hidden, a pixel or
   * two in size (the "visually hidden" pattern), clipped away, or moved off the page.
   */
  function usable(el) {
    if (!rendered(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const w = el.ownerDocument.defaultView || window;
    if (r.right + w.scrollX <= 0 || r.bottom + w.scrollY <= 0) return false;
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
    for (let p = el, i = 0; p && i < 300; p = parentX(p), i++) {
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
    let entered = 0;
    while (stack.length) {
      const [node, inside] = stack.pop();
      let listed = false;
      // A frame cctether can reach: its elements are listed where it is, instead of the frame.
      if (isFrameEl(node) && reachable(node)) {
        const d = frameDoc(node);
        const top = d.body || d.documentElement;
        if (top) stack.push([top, false]);
        entered++;
        continue;
      }
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
          if (!kind && !inside && !isRootEl(node)) {
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
    // A line wherever the listed elements go into a frame, or back out of one.
    let prev = root.ownerDocument;
    for (let i = 0; i < shown; i++) {
      if (heads.has(i)) {
        lines.push(heads.get(i));
        prev = document;
      }
      const d = order[i].at.ownerDocument;
      if (d !== prev) {
        lines.push(d === document ? '── back in the page ──' : `── in ${frameName(hostFrame(d))} ──`);
        prev = d;
      }
      lines.push(line(order[i].el, order[i].kind, order[i].at));
    }
    return {
      title: document.title, url: location.href, lines, total: items.length, shown, grouped: heads.size > 0, vw: vw(), vh: vh(),
      frames: entered, blind: frames().filter((f) => !f.doc && composedContains(root, f.el)).length,
    };
  }

  function html(o) {
    const found = o.selector ? resolve({ selector: o.selector }, { firstMatch: true }) : (document.body || document.documentElement);
    if (found.__error) return found;
    const root = frameRoot(found);
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
    // Frames' documents are not in it: say so (a selector naming the frame shows its HTML).
    const inner = frames().filter((f) => f.doc && composedContains(root, f.el)).length;
    return { title: document.title, url: location.href, html: clone.outerHTML, scripts, styles, attrs, frames: inner };
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
      // The page first, then the frames cctether can reach.
      list = [];
      for (const d of allDocs()) {
        const l = queryAll(d, o.selector);
        if (l.__error) return l;
        for (const el of l) list.push(el);
      }
    }
    const items = [];
    const n = Math.min(list.length, o.limit || 20);
    for (let i = 0; i < n; i++) {
      const el = list[i];
      const r = topRect(el);
      const attrs = [];
      for (const a of FIND_ATTRS) {
        let v = el.getAttribute(a);
        if (a === 'src' && isFrameEl(el) && v != null) v = frameSrc(el).text;
        if (v != null && v !== '') attrs.push(`${a}=${JSON.stringify(clip(v, a === 'href' || a === 'src' ? 120 : 60))}`);
      }
      if (isFrameEl(el)) attrs.push(frameDoc(el) ? 'same-origin (searched too)' : "cross-origin or sandboxed (can't be searched)");
      const v = valueText(el);
      if ((el.localName === 'input' || el.localName === 'textarea') && v) attrs.push(`value=${JSON.stringify(clip(v, 80))}`);
      if (el.localName === 'select') attrs.push(`value=${JSON.stringify(clip(selectedLabels(el).join(', '), 80))}`);
      if (el.checked) attrs.push('checked');
      if (el.disabled) attrs.push('disabled');
      const vis = rendered(el) ? (where(el) ? `offscreen ${where(el)}` : 'visible') : 'hidden';
      let text = '';
      if (el.localName !== 'select' && el.localName !== 'input' && el.localName !== 'textarea') {
        text = clip(norm(el.innerText ?? el.textContent ?? ''), 100);
      }
      let tag = el.localName;
      if (el.id) tag += `#${clip(el.id, 40)}`;
      const cls = [...el.classList].slice(0, 3).map((c) => clip(c, 30));
      if (cls.length) tag += `.${cls.join('.')}`;
      items.push({
        ref: ref(el), tag, attrs, text, vis, frame: inFrame(el),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        contains: tiers ? tiers[i] === 2 : false,
      });
    }
    return { count: list.length, exact: tiers ? tiers.filter((t) => t < 2).length : null, items, blind: blindNote() };
  }

  // ---- pointer targets -------------------------------------------------------------------------
  /** Scroll the element into view and pick the point a user would click. */
  function point(o) {
    const el = resolve(o);
    if (el.__error) return el;
    if (!plainDoc(el.ownerDocument)) return transformedError(el);
    // Also scroll it in when a scrolling box around it cuts it off (an option far down a list),
    // even if that part of the box is inside the viewport.
    const r0 = el.getBoundingClientRect();
    if (!fullyVisible(el) || cutOff(clipBy(scrollers(el), r0), r0)) scrollIntoViewCentered(el);
    return pointOf(el);
  }

  /** The point to press on el as things are now (no scrolling), in the page's viewport. */
  function pointOf(el) {
    const rects = [...el.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
    if (!rects.length || !rendered(el)) {
      return ERR('no_element', `${labelIn(el)} is not visible (hidden or zero size). Check it with find, or wait_for it to appear.`);
    }
    const d = el.ownerDocument;
    const framed = d !== document;
    const o = docOffset(d);
    const view = framed ? docClip(d) : viewport();
    const tr = rects.map((x) => shift(x, o));
    const rr = tr.find((x) => x.bottom > view.top && x.right > view.left && x.top < view.bottom && x.left < view.right) || tr[0];
    let box = meet(rr, view);
    // Aim at the part the scrolling boxes leave visible. If the calculation finds none (e.g. a
    // positioned element that escapes its box), keep the viewport part; but in a frame, the
    // frame's edge really does cut it off.
    const c = meet(box, shift(clipBy(scrollers(el), INF), o));
    if ((c.right > c.left && c.bottom > c.top) || framed) box = c;
    if (box.right <= box.left || box.bottom <= box.top) {
      return ERR('no_element', framed
        ? `${labelIn(el)} could not be scrolled into view: its frame cuts it off.`
        : `${label(el)} could not be scrolled into the viewport.`);
    }
    const x = (box.left + box.right) / 2;
    const y = (box.top + box.bottom) / 2;
    const hit = deepElementFromPoint(x, y);
    let covered = null;
    if (hit && hit !== el && !composedContains(el, hit)) {
      const viaLabel = el.labels && [...el.labels].some((l) => composedContains(l, hit));
      if (!viaLabel) covered = shortDesc(hit) + inFrame(hit);
    } else if (!hit && framed) covered = 'nothing that cctether can see';
    return { x, y, desc: labelIn(el), covered, ref: ref(el), doc: docToken, framed };
  }

  /**
   * Right before pressing at (x, y), with no scrolling: is o.ref's element still the one on top
   * at that very point, unchanged and where it was? { why: null } if so, else why not.
   */
  function pressCheck(o) {
    const el = resolve({ ref: o.ref, doc: o.doc });
    if (el.__error) return el;
    const p = pointOf(el);
    if (p.__error) return { why: 'it is no longer visible' };
    if (p.desc !== o.desc) return { why: `it changed (now ${p.desc})` };
    if (Math.abs(p.x - o.x) > 2 || Math.abs(p.y - o.y) > 2) return { why: 'it moved' };
    const hit = deepElementFromPoint(o.x, o.y);
    const onIt = !!hit && (hit === el || composedContains(el, hit) || (!!el.labels && [...el.labels].some((l) => composedContains(l, hit))));
    if (!onIt) return { why: `${hit ? shortDesc(hit) + inFrame(hit) : 'something cctether can\'t see'} came on top of it` };
    return { why: null };
  }

  /** Like point(), without scrolling: where the element is now (drag measures its end with it). */
  function pointNow(o) {
    const el = resolve(o);
    if (el.__error) return el;
    if (!plainDoc(el.ownerDocument)) return transformedError(el);
    return pointOf(el);
  }

  // ---- drag ------------------------------------------------------------------------------------
  // drag (tools/input.js) moves the real mouse; when the page turns that into HTML drag and drop,
  // these note what happened, for the result. Only trusted events count.
  let dragSeen = null;
  const nodeEl = (t) => (t && t.nodeType === 1 ? t : t?.parentElement ?? null);

  function dragWatch() {
    dragUnwatch();
    const st = { start: null, drop: null, ended: false, effect: null, offs: [] };
    for (const d of allDocs()) {
      const w = d.defaultView;
      if (!w) continue;
      const on = (type, fn) => {
        const h = (e) => { if (e.isTrusted) fn(e); };
        w.addEventListener(type, h, true);
        st.offs.push(() => w.removeEventListener(type, h, true));
      };
      on('dragstart', (e) => { const el = nodeEl(e.target); if (el && !st.start) st.start = labelIn(el); });
      on('drop', (e) => { const el = nodeEl(e.target); if (el) st.drop = labelIn(el); });
      on('dragend', (e) => { st.ended = true; st.effect = e.dataTransfer?.dropEffect ?? null; });
    }
    dragSeen = st;
    return true;
  }

  function dragUnwatch() {
    for (const off of dragSeen?.offs ?? []) { try { off(); } catch { /* frame gone */ } }
    dragSeen = null;
  }

  /** What the page did with the drag (null if not watching), and stop watching. */
  function dragResult() {
    const st = dragSeen;
    dragUnwatch();
    return st && { start: st.start, drop: st.drop, ended: st.ended, effect: st.effect };
  }

  /** What is at a viewport point. */
  function at(o) {
    const W = vw();
    const H = vh();
    if (o.x < 0 || o.y < 0 || o.x >= W || o.y >= H) {
      return ERR('bad_args', `(${o.x}, ${o.y}) is outside the viewport, which is ${W}×${H} CSS pixels. Scroll first, or use ref/selector.`);
    }
    const hit = deepElementFromPoint(o.x, o.y);
    return { desc: hit ? labelIn(hit) : 'nothing', vw: W, vh: H };
  }

  function elementRect(o) {
    const el = resolve(o);
    if (el.__error) return el;
    const d = el.ownerDocument;
    if (!plainDoc(d)) return transformedError(el);
    if (!fullyVisible(el)) {
      const v = d === document ? viewport() : docClip(d);
      const r0 = el.getBoundingClientRect();
      if (r0.height > v.bottom - v.top || r0.width > v.right - v.left) {
        scrollIntoViewCentered(el, 'start');
      } else {
        scrollIntoViewCentered(el);
      }
    }
    let r = topRect(el);
    if (!(r.width > 0 && r.height > 0)) {
      return ERR('no_element', `${labelIn(el)} has no size (it is hidden or empty), so there is nothing to screenshot.`);
    }
    // In a frame, only what can be seen through the frame is drawn.
    let cut = false;
    if (d !== document) {
      const m = meet(r, docClip(d));
      if (!(m.right > m.left && m.bottom > m.top)) return ERR('no_element', `${labelIn(el)} can't be seen through its frame (scrolled away or cut off), so there is nothing to screenshot.`);
      cut = m.left > r.left + 0.5 || m.top > r.top + 0.5 || m.right < r.right - 0.5 || m.bottom < r.bottom - 0.5;
      r = { left: m.left, top: m.top, width: m.right - m.left, height: m.bottom - m.top };
    }
    return { x: r.left, y: r.top, width: r.width, height: r.height, desc: labelIn(el), vw: vw(), vh: vh(), cut };
  }

  function metrics(o) {
    const se = document.scrollingElement || document.documentElement;
    return {
      ...(o && o.shot ? shotState() : {}),
      dpr: window.devicePixelRatio || 1,
      vw: vw(), vh: vh(),
      scrollX: window.scrollX, scrollY: window.scrollY,
      docW: Math.max(se.scrollWidth, document.documentElement.clientWidth),
      docH: Math.max(se.scrollHeight, document.documentElement.clientHeight),
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      // The page hides its own scrollbar (overflow: hidden): its user can't scroll it.
      locked: getComputedStyle(document.documentElement).overflowY === 'hidden'
        || (!!document.body && getComputedStyle(document.documentElement).overflowY === 'visible' && getComputedStyle(document.body).overflowY === 'hidden'),
      doc: docToken,
      // When this document's navigation started (ms since 1970).
      t0: performance.timeOrigin,
    };
  }

  // ---- what a screenshot showed (SPEC §5.2) ------------------------------------------------------
  // To check, before pressing at a point of a screenshot, that what is there now is what the
  // screenshot showed: the frames (position, document, scroll) and the scrolled areas.
  const shotMarks = new Map(); // key -> WeakMap<Element, [scrollTop, scrollLeft]> (non-zero only)
  let nextMark = 1;
  const tokens = new WeakMap(); // frame element or document -> token
  function tokenOf(x) {
    if (x === document) return docToken;
    let t = tokens.get(x);
    if (!t) { t = `${nextMark++}.${Math.random().toString(36).slice(2, 8)}`; tokens.set(x, t); }
    return t;
  }

  /**
   * A frame as recorded: its content box in page px, whether it is drawn plainly (no rotation or
   * scaling), and its document and scroll if reachable.
   */
  function frameRecord(f) {
    const b = shift(contentBox(f.el), docOffset(f.el.ownerDocument));
    const w = f.doc ? f.doc.defaultView : null;
    return {
      t: tokenOf(f.el), d: f.doc ? tokenOf(f.doc) : null, p: !transformed(f.el) && plainDoc(f.el.ownerDocument),
      x: b.left + window.scrollX, y: b.top + window.scrollY, w: b.right - b.left, h: b.bottom - b.top,
      sx: w ? w.scrollX : null, sy: w ? w.scrollY : null,
    };
  }

  /** The frame elements a point goes to now: those entered, and the frame element hit itself. */
  function framesAt(x, y) {
    const h = deepHit(x, y);
    return { h, list: isFrameEl(h.el) ? [...h.frames, h.el] : h.frames };
  }

  /** Is the frame on top all over the part of it that can be seen (sampled on a 3×3 grid)? */
  function onTop(fe) {
    const c = meet(shift(contentBox(fe), docOffset(fe.ownerDocument)), fe.ownerDocument === document ? viewport() : docClip(fe.ownerDocument));
    if (!(c.right - c.left >= 3 && c.bottom - c.top >= 3)) return false;
    for (const fx of [0.1, 0.5, 0.9]) {
      for (const fy of [0.1, 0.5, 0.9]) {
        if (!framesAt(c.left + (c.right - c.left) * fx, c.top + (c.bottom - c.top) * fy).list.includes(fe)) return false;
      }
    }
    return true;
  }

  function shotState() {
    const marks = new WeakMap();
    let n = 0;
    const scan = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (++n > 60000) return;
        if (el.scrollTop || el.scrollLeft) marks.set(el, [el.scrollTop, el.scrollLeft]);
        if (el.shadowRoot) scan(el.shadowRoot);
      }
    };
    for (const d of allDocs()) scan(d);
    const key = nextMark++;
    shotMarks.set(key, marks);
    while (shotMarks.size > 25) shotMarks.delete(shotMarks.keys().next().value);
    return { key, frames: frames().map((f) => ({ ...frameRecord(f), top: onTop(f.el) })) };
  }

  /**
   * Is viewport point (x, y) still as screenshot o.key showed it? { changed: [reasons] }.
   * - Each frame the point goes to now must have been there, unchanged (document, place, scroll,
   *   drawn plainly).
   * - A frame that was at the point but is not what the point goes to now: if it is gone, the
   *   point shows something else; if it was on top all over then (the screenshot showed it
   *   there) and has changed since, too. Unchanged, or partly covered then (it may have been
   *   covered right there), it doesn't matter: what is on top now gets the click, and the
   *   result says what that was, as for the page's own elements.
   * - The areas that scroll around the point must not have scrolled.
   */
  function shotCheck(o) {
    const out = [];
    const near = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) <= 1;
    const rec = new Map((o.frames || []).map((r) => [r.t, r]));
    const now = new Map(frames().map((f) => [tokenOf(f.el), f]));
    const same = (r, fe) => {
      const c = frameRecord({ el: fe, doc: frameDoc(fe) });
      return (c.d ?? null) === (r.d ?? null) && c.p === !!r.p && near(c.x, r.x) && near(c.y, r.y) && near(c.w, r.w) && near(c.h, r.h)
        && near(c.sx, r.sx) && near(c.sy, r.sy);
    };
    const { h, list } = framesAt(o.x, o.y);
    const at = new Set(list.map((fe) => tokenOf(fe)));
    // Reasons a new screenshot wouldn't help: say so instead of "take a new screenshot".
    for (const fe of list) {
      if (!now.has(tokenOf(fe))) {
        return { refuse: 'that point is in a frame cctether does not keep track of (it follows at most 20 frames, 5 deep)', instead: 'Use ref or text (from read_page or find) instead' };
      }
      if (transformed(fe) || !plainDoc(fe.ownerDocument)) {
        return { refuse: 'that point is on a frame that is rotated, scaled or zoomed (CSS)', instead: 'Its elements can be read, but nothing in it can be pressed by position: use evaluate to work with them' };
      }
    }
    for (const fe of list) {
      const r = rec.get(tokenOf(fe));
      if (!r || !same(r, fe) || !r.p) {
        out.push('the frame at that point has navigated, scrolled, moved or changed');
        break;
      }
    }
    const px = o.x + window.scrollX;
    const py = o.y + window.scrollY;
    for (const r of o.frames || []) {
      if (at.has(r.t) || px < r.x || py < r.y || px >= r.x + r.w || py >= r.y + r.h) continue;
      const f = now.get(r.t);
      if (!f) { out.push('the frame that was at that point is gone'); break; }
      if (r.top && !same(r, f.el)) { out.push('the frame that was at that point has changed'); break; }
    }
    const marks = shotMarks.get(o.key);
    if (!marks) out.push('cctether no longer has its record of that screenshot');
    else {
      for (let n = h.el, i = 0; n && i < 5000; n = upNode(n), i++) {
        if (n.nodeType !== 1 || n === n.ownerDocument.scrollingElement) continue;
        const [t, l] = marks.get(n) ?? [0, 0];
        if (Math.abs(n.scrollTop - t) > 1 || Math.abs(n.scrollLeft - l) > 1) {
          out.push('an area that scrolls at that point was scrolled');
          break;
        }
      }
    }
    return { changed: out };
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

  /** Does focus on a mean typing goes where el says: el itself, inside it, or label el's control? */
  function owns(el, a) {
    if (!a) return false;
    if (a === el || composedContains(el, a)) return true;
    return el.localName === 'label' && !!el.control && el.control === a;
  }

  /** The focused element is a frame cctether can't look into (e.g. another site's card field). */
  const blindFocus = (a) => isFrameEl(a) && !frameDoc(a);

  function focus(o) {
    const el = resolve(o);
    if (el.__error) return el;
    if (!fullyVisible(el)) scrollIntoViewCentered(el);
    if (el.disabled) return ERR('no_element', `${labelIn(el)} is disabled, so it can't be typed into.`);
    if (blindFocus(el)) {
      return ERR('no_element', `${labelIn(el)} is a frame cctether can't see into (another site's, or sandboxed), so it can't check where the text would go. Click the field inside it (e.g. at a point of a screenshot), then call type without ref or selector (and without clear or submit).`);
    }
    try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
    const a = deepActive();
    const focused = owns(el, a);
    return {
      focused, desc: labelIn(el), editable: isEditable(focused ? a : el), ref: focused ? ref(a) : null, doc: docToken,
      target: ref(el), blind: focused && blindFocus(a),
    };
  }

  /** After clicking el to focus it: did focus go to it? Then the focused element, as from active(). */
  function focusedOn(o) {
    const el = resolve(o);
    if (el.__error) return el;
    const a = deepActive();
    if (!owns(el, a)) return { ok: false, now: a && !isRootEl(a) ? labelIn(a) : 'nothing' };
    return { ok: true, ...active() };
  }

  /** Describe the focused element. */
  function active() {
    const a = deepActive();
    if (!a || isRootEl(a)) return { none: true };
    const v = valueText(a);
    return {
      none: false, desc: labelIn(a), editable: isEditable(a), value: v == null ? null : clip(v, 300), password: a.type === 'password',
      ref: ref(a), doc: docToken, blind: blindFocus(a),
    };
  }

  /**
   * The element typing was pinned to (o.pin: { ref, doc }) if it still has the focus, else an
   * error saying where the focus went: the page may move it (a key handler, autocomplete), and
   * then clearing or typing would hit another field.
   */
  function pinned(o) {
    const el = resolve(o.pin);
    if (el.__error) return el;
    const a = deepActive();
    if (a !== el) {
      return ERR('no_element', `Stopped ${o.when || 'typing'}: the focus moved from ${labelIn(el)} to ${a && !isRootEl(a) ? labelIn(a) : 'nothing'}. Check the page (read_page or screenshot) before trying again.`);
    }
    return el;
  }

  const checkFocus = (o) => {
    const el = pinned(o);
    return el.__error ? el : { ok: true };
  };

  /** Select the whole content of the pinned field, so the next key press replaces it. */
  function selectAllInFocused(o) {
    const a = pinned(o);
    if (a.__error) return a;
    if (a.localName === 'input' || a.localName === 'textarea') {
      try { a.select(); } catch { /* some input types can't be selected */ }
      return { kind: 'field', len: a.value.length };
    }
    const host = editingHost(a);
    if (host) {
      const doc = host.ownerDocument;
      const range = doc.createRange();
      range.selectNodeContents(host);
      const sel = (doc.defaultView || window).getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return { kind: 'editable', len: host.innerText.replace(/\n$/, '').length };
    }
    return { kind: 'other', len: 0 };
  }

  function focusedLength(o) {
    const a = pinned(o);
    if (a.__error) return a;
    if (a.localName === 'input' || a.localName === 'textarea') return a.value.length;
    const host = editingHost(a);
    return host ? host.innerText.replace(/\n$/, '').length : 0;
  }

  /** Last resort for clearing: set the value directly and fire an input event. */
  function forceClear(o) {
    const a = pinned(o);
    if (a.__error) return a;
    if (a.localName === 'input' || a.localName === 'textarea') {
      // The value setter of the element's own window (a page may hook the element's own one).
      const w = a.ownerDocument.defaultView || window;
      const proto = a.localName === 'input' ? w.HTMLInputElement.prototype : w.HTMLTextAreaElement.prototype;
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

  /** The value of the pinned element (wherever the focus is now). */
  function valueOf(o) {
    const el = resolve(o.pin);
    if (el.__error) return el;
    const v = valueText(el);
    return { value: v == null ? null : clip(v, 300), password: el.type === 'password' };
  }

  // ---- select_option ---------------------------------------------------------------------------
  function selectOption(o) {
    const el = resolve(o, { firstMatch: true });
    if (el.__error) return el;
    if (el.localName !== 'select') {
      return ERR('bad_args', `${labelIn(el)} is a <${el.localName}>, not a <select>. For a custom dropdown, click it to open it, then click the option (read_page mode "interactive" lists them).`);
    }
    if (el.disabled) return ERR('bad_args', `${labelIn(el)} is disabled.`);
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
        desc: labelIn(el),
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
    return { matched: true, desc: labelIn(el), chosen: selectedLabels(el), unmatched, multiple: el.multiple };
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
      if (p === el.ownerDocument.body) break;
      if (declaresList(p)) return p;
    }
    const inner = [...el.querySelectorAll('[role],[aria-haspopup]')].filter((x) => declaresList(x) && rendered(x));
    return inner.length === 1 ? inner[0] : null;
  }

  function byIds(el, attr) {
    const ids = (el.getAttribute(attr) || '').trim();
    if (!ids) return [];
    const root = el.getRootNode();
    return ids.split(/\s+/).map((id) => (root.getElementById ? root.getElementById(id) : null) || el.ownerDocument.getElementById(id)).filter(Boolean);
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

  /**
   * What a dropdown displays as its choice now. Some widgets keep their open list inside the
   * dropdown element (e.g. Angular Material in a popover): its options are not part of it.
   */
  function shownValue(el) {
    // Zero-width characters (MUI's placeholder for "nothing chosen") count as nothing here.
    const norm = (t) => String(t ?? '').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    if (roleOf(el) === 'listbox') return optionsIn(el, []).filter(isOn).map(optionLabel).join(', ');
    if (el.localName === 'input' || el.localName === 'textarea') return norm(el.value);
    const isList = (n) => n.nodeType === 1 && (OPTION_ROLES.has(roleOf(n)) || ['listbox', 'menu', 'tree', 'dialog'].includes(roleOf(n)));
    if (!el.querySelector('[role]') || ![...el.querySelectorAll('[role]')].some(isList)) return norm(el.innerText || '');
    const text = (n) => {
      if (n.nodeType === 3) return n.data;
      if (n.nodeType !== 1 || isList(n) || !rendered(n)) return '';
      if (![...n.querySelectorAll('[role]')].some(isList)) return ` ${n.innerText || ''} `;
      return [...n.childNodes].map(text).join(' ');
    };
    return norm([...el.childNodes].map(text).join(' '));
  }

  /**
   * Milliseconds until the animations and transitions that move or fade the option (on it or
   * on a box around it, e.g. a menu growing open) are done; 0 if none. Endless ones don't count.
   * Widgets often ignore a click while their list is still opening.
   */
  function ddSettling(o) {
    const el = resolve({ ref: o.ref, doc: o.doc });
    if (el.__error) return el;
    let left = 0;
    for (const a of el.ownerDocument.getAnimations()) {
      const t = a.effect && a.effect.target;
      if (!t || !(a.playState === 'running' || a.pending) || !composedContains(t, el)) continue;
      const timing = a.effect.getComputedTiming();
      if (!Number.isFinite(timing.endTime) || a.currentTime == null) continue;
      left = Math.max(left, timing.endTime - a.currentTime);
    }
    return { left: Math.max(0, Math.ceil(left)) };
  }

  function ddTarget(o) {
    const el = resolve(o, { firstMatch: true });
    if (el.__error) return el;
    // The native select is named by its number from here on: resolved once (SPEC §5.2).
    if (el.localName === 'select') return { native: true, ref: ref(el), doc: docToken, desc: labelIn(el) };
    const d = dropdownOf(el);
    if (!d) {
      return ERR('bad_args', `${labelIn(el)} is a <${el.localName}>: not a <select>, and it doesn't say it is a dropdown (role "combobox" or "listbox", or aria-haspopup="listbox"), so cctether won't guess how to use it. Click it to open it, then click the option (click with text, or a ref from read_page mode "interactive").`);
    }
    if (d.disabled || d.getAttribute('aria-disabled') === 'true') return ERR('bad_args', `${label(d)} is disabled.`);
    const name = clip(accName(d), 60);
    const kind = kindOf(d) || roleOf(d) || d.localName;
    return {
      native: false, ref: ref(d), doc: docToken, desc: (name ? `${kind} ${JSON.stringify(name)}` : kind) + inFrame(d), list: roleOf(d) === 'listbox',
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
    const el = refEl(o.opt.ref);
    const hit = deepElementFromPoint(o.x, o.y);
    const onTop = !!el && !!hit && (hit === el || composedContains(el, hit));
    return { same, now: opt || null, selected: !!opt?.selected, multi: !!r.multi, onTop, hit: hit ? shortDesc(hit) : 'nothing' };
  }

  /**
   * What the dropdown shows now, whether it is still open, and whether something (its closing
   * list, a backdrop) still lies over its middle. { gone: true } if it is no longer there.
   */
  function ddShown(o) {
    const d = o.doc === docToken ? refEl(o.ref) : null;
    if (!d) return { gone: true };
    const r = topRect(d);
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let covered = false;
    if (x >= 0 && y >= 0 && x < vw() && y < vh()) {
      const hit = deepElementFromPoint(x, y);
      covered = !!hit && !composedContains(d, hit) && !composedContains(hit, d);
    }
    return { shown: shownValue(d), expanded: d.getAttribute('aria-expanded') === 'true', covered };
  }

  /** Option-like elements visible anywhere now (for "click the right one yourself"). */
  function visibleOptions(o) {
    const opts = [];
    for (const d of allDocs()) optionsIn(d.body || d.documentElement, opts);
    return { total: opts.length, lines: opts.slice(0, o.limit || 30).map((x) => candidate(x, 0)) };
  }

  // ---- full capture of a scrolling element ------------------------------------------------------
  /** Does the element paint a background of its own (a colour that isn't transparent, or an image)? */
  function paints(el) {
    const cs = getComputedStyle(el);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    if (!m) return cs.backgroundColor !== 'transparent';
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length < 4 || parseFloat(parts[3]) > 0;
  }

  /**
   * What hides part of the box at a scroll step, in px from its top and bottom edges:
   * - top / bottom: sticky or fixed bars inside the element, stuck to its edge (part of the
   *   content: shown once, at the top / bottom of the stitched image);
   * - topOut / bottomOut: things outside it floating over it, e.g. a cookie banner (not part of
   *   it: the rows under them are taken from another step, or reported as not captured);
   * - over: descriptions of those outside things.
   */
  function edgeBars(el, box) {
    const res = { top: 0, bottom: 0, topOut: 0, bottomOut: 0, over: [] };
    const xs = [0.1, 0.5, 0.9].map((f) => box.left + box.width * f);
    const bottomEdge = box.top + box.height;
    // Inside: stuck to an edge.
    for (const [y, atTop] of box.cut ? [[box.top + 1, true]] : [[box.top + 1, true], [bottomEdge - 2, false]]) {
      for (const x of xs) {
        for (const h of document.elementsFromPoint(x, y)) {
          if (h === el || !composedContains(el, h)) continue;
          for (let p = h; p && p !== el; p = parentOf(p)) {
            const pos = getComputedStyle(p).position;
            if (pos !== 'sticky' && pos !== 'fixed') continue;
            const r = p.getBoundingClientRect();
            if (atTop && r.top <= box.top + 1) res.top = Math.max(res.top, r.bottom - box.top);
            if (!atTop && r.bottom >= bottomEdge - 1) res.bottom = Math.max(res.bottom, bottomEdge - r.top);
          }
        }
      }
    }
    // Outside: whatever is on top anywhere in the top and bottom 40% of the box. Columns closer
    // than a third of the width apart, so that anything across a third of it is seen.
    const band = box.height * 0.4;
    const over = new Map();
    const cols = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95].map((f) => box.left + box.width * f);
    for (let dy = 1; dy <= band; dy += 8) {
      for (const [y, atTop] of [[box.top + dy, true], [bottomEdge - 1 - dy, false]]) {
        if (!atTop && box.cut) continue;
        for (const x of cols) {
          // A frame floating over it counts as one thing (positions inside it are its own).
          const hit = pageElementFromPoint(x, y);
          if (!hit || composedContains(el, hit) || composedContains(hit, el)) continue;
          // Something as big as the page (a backdrop, a transparent layer) can't be avoided by
          // scrolling: name it only.
          if (hit.getBoundingClientRect().height > band) { over.set(hit, tagDesc(hit)); continue; }
          // The floating thing that covers this point: the hit element, or an ancestor around it
          // that is still band-sized and visibly paints (a transparent wrapper hides nothing).
          let bar = hit;
          for (let p = parentOf(hit); p && !composedContains(p, el); p = parentOf(p)) {
            const pr = p.getBoundingClientRect();
            if (pr.height > band || pr.width > box.width * 1.5 + 40) break;
            if (paints(p)) bar = p;
          }
          over.set(bar, tagDesc(bar));
          // Only something across a good part of its width costs whole rows; a small widget in a
          // corner is just mentioned (it may show up in more than one part of the image).
          const r = bar.getBoundingClientRect();
          const wide = Math.min(r.right, box.left + box.width) - Math.max(r.left, box.left) >= box.width / 3;
          if (!wide) continue;
          if (atTop) res.topOut = Math.max(res.topOut, r.bottom - box.top);
          else res.bottomOut = Math.max(res.bottomOut, bottomEdge - r.top);
        }
      }
    }
    res.over = [...over.values()].slice(0, 3);
    // Floating things usually cast a shadow beyond their box.
    if (res.topOut) res.topOut += 8;
    if (res.bottomOut) res.bottomOut += 8;
    // A bar taller than 40% of the box is not a bar.
    for (const k of ['top', 'bottom', 'topOut', 'bottomOut']) res[k] = Math.min(Math.max(0, Math.ceil(res[k])), Math.floor(band));
    return res;
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
    if (isFrameEl(el) || el.ownerDocument !== document) {
      return ERR('bad_args', `${labelIn(el)} is ${isFrameEl(el) ? 'a frame' : 'in a frame'} (iframe): capturing all of what scrolls inside a frame in one image isn't supported yet. Scroll it with scroll (direction "down") and take more screenshots.`);
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
    const el = o.doc === docToken ? refEl(o.ref) : null;
    if (!el) return false;
    if (Math.abs(el.scrollTop - o.expect) > 2) return false;
    try { el.scrollTo({ top: o.top, behavior: 'instant' }); } catch { el.scrollTop = o.top; }
    return true;
  }

  /** Does a frame's document scroll vertically (as a whole)? */
  function docScrollsY(d) {
    const se = d.scrollingElement || d.documentElement;
    if (!(se.scrollHeight > se.clientHeight + 1)) return false;
    if (getComputedStyle(d.documentElement).overflowY === 'hidden') return false;
    return !(d.body && getComputedStyle(d.documentElement).overflowY === 'visible' && getComputedStyle(d.body).overflowY === 'hidden');
  }

  /**
   * The element the page's content scrolls in, when the page itself doesn't scroll. It may be a
   * frame (its document scrolls) or inside one: then frame is true (it can't be stitched yet).
   */
  function mainScroller() {
    const best = { el: null, area: 0, frame: null };
    const seen = new Set();
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.6], [0.7, 0.6], [0.5, 0.8]]) {
      const h = deepHit(vw() * fx, vh() * fy);
      for (let p = h.el; p && !isRootEl(p); p = parentOf(p)) {
        if (seen.has(p)) continue;
        seen.add(p);
        const cs = getComputedStyle(p);
        if (!(SCROLLS.test(cs.overflowY) && cs.overflowY !== 'hidden' && p.scrollHeight > p.clientHeight + 1)) continue;
        const area = p.clientWidth * p.clientHeight;
        if (area > best.area) Object.assign(best, { el: p, area, frame: null });
      }
      for (const fe of h.frames) {
        if (seen.has(fe)) continue;
        seen.add(fe);
        const d = frameDoc(fe);
        if (!d || !docScrollsY(d)) continue;
        const b = contentBox(fe);
        const area = (b.right - b.left) * (b.bottom - b.top);
        if (area > best.area) Object.assign(best, { el: fe, area, frame: d });
      }
    }
    if (!best.el || best.area < vw() * vh() * 0.3) return null;
    if (best.frame) {
      const se = best.frame.scrollingElement || best.frame.documentElement;
      return { ref: ref(best.el), desc: frameName(best.el), height: se.scrollHeight, frame: true };
    }
    const framed = best.el.ownerDocument !== document;
    return { ref: ref(best.el), desc: tagDesc(best.el) + inFrame(best.el), height: best.el.scrollHeight, frame: framed };
  }

  // ---- wait_for --------------------------------------------------------------------------------
  /**
   * One check of a wait_for condition, in the page and the frames cctether can reach. With
   * o.locate, a text found is also located (in this same check, so it names where it was found).
   */
  function waitCheck(o) {
    let found = false;
    let desc = '';
    if (o.selector) {
      outer: for (const d of allDocs()) {
        const list = queryAll(d, o.selector);
        if (list.__error) return list;
        for (const el of list) {
          // Visible text only: a hidden "Ready" inside a visible box doesn't count.
          if (rendered(el) && (!o.text || (el.innerText || '').includes(o.text))) {
            found = true;
            desc = `[${ref(el)}] ${labelIn(el)}`;
            break outer;
          }
        }
      }
    } else {
      let where = null;
      for (const d of allDocs()) {
        if ((d.body ? d.body.innerText : d.documentElement.textContent || '').includes(o.text)) { found = true; where = d; break; }
      }
      // Located in the document the text was found in, not wherever something else matches.
      if (found && o.locate) {
        const ms = textMatches(o.text, null, [where]);
        if (!ms.__error && ms.length) {
          const more = ms.length > 1 ? ` (and ${ms.length - 1} more place${ms.length > 2 ? 's' : ''})` : '';
          desc = `[${ref(ms[0].el)}] ${labelIn(ms[0].el)}${more}`;
        }
      }
    }
    return { found, desc, ready: document.readyState, doc: docToken, blind: frames().filter((f) => !f.doc).length };
  }

  // ---- scrolling -------------------------------------------------------------------------------
  const SCROLLS_AUTO = /(auto|scroll|overlay)/;

  /** Does element n scroll by itself (not counting a document's own scrolling)? */
  function scrollsBox(n) {
    const cs = getComputedStyle(n);
    return (SCROLLS_AUTO.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1)
      || (SCROLLS_AUTO.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1);
  }

  /**
   * The areas that scroll around viewport point (x, y), innermost first: elements, and the
   * documents of frames cctether can reach (as their scrollingElement). The page itself is not
   * in it (it is reported separately).
   */
  function scrollChainAt(x, y) {
    const out = [];
    for (let n = deepElementFromPoint(x, y), i = 0; n && i < 5000 && out.length < 12; n = upNode(n), i++) {
      if (n.nodeType === 9) {
        if (n === document) break;
        const se = n.scrollingElement || n.documentElement;
        if (se.scrollHeight > se.clientHeight + 1 || se.scrollWidth > se.clientWidth + 1) out.push(se);
        continue;
      }
      if (n.nodeType !== 1 || n === n.ownerDocument.scrollingElement || n === n.ownerDocument.body) continue;
      if (scrollsBox(n)) out.push(n);
    }
    return out;
  }

  /** How a scrolling area is named: a frame's document as the frame. */
  function scrollDesc(sc) {
    const d = sc.ownerDocument;
    if (d !== document && sc === (d.scrollingElement || d.documentElement)) return frameName(hostFrame(d));
    return shortDesc(sc).split(' ')[0] + inFrame(sc);
  }

  /**
   * The page's scroll position, and those of the areas around a point: with x, y, found there
   * now; with chain (their numbers, from an earlier call), the same areas again (lost: one of
   * them is gone).
   */
  function scrollState(o) {
    const se = document.scrollingElement || document.documentElement;
    const out = {
      page: {
        x: Math.round(window.scrollX), y: Math.round(window.scrollY),
        maxX: Math.max(0, se.scrollWidth - se.clientWidth), maxY: Math.max(0, se.scrollHeight - se.clientHeight),
        vw: vw(), vh: vh(),
      },
      chain: [],
      doc: docToken,
    };
    let els = [];
    if (o && o.chain) {
      for (const n of o.chain) {
        const el = o.doc === docToken ? refEl(n) : null;
        if (!el) return { ...out, lost: true };
        els.push(el);
      }
    } else if (o && o.x != null) els = scrollChainAt(o.x, o.y);
    out.chain = els.map((sc) => ({
      ref: ref(sc), desc: scrollDesc(sc), top: Math.round(sc.scrollTop), left: Math.round(sc.scrollLeft),
      maxTop: sc.scrollHeight - sc.clientHeight, maxLeft: sc.scrollWidth - sc.clientWidth,
    }));
    return out;
  }

  function scrollTo(o) {
    const el = resolve(o);
    if (el.__error) return el;
    scrollIntoViewCentered(el);
    const r = topRect(el);
    return { desc: labelIn(el), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  /**
   * Fallback when a synthetic wheel event did not scroll anything: scroll the first of the areas
   * (o.chain, from scrollState) that can still move that way, else the page. Not done (false) if
   * one of them is gone: then cctether can't tell what the wheel would have moved.
   */
  function scrollByJs(o) {
    const els = [];
    for (const n of o.chain || []) {
      const el = o.doc === docToken ? refEl(n) : null;
      if (!el) return false;
      els.push(el);
    }
    const can = (sc) => (o.dy > 0 ? sc.scrollTop < sc.scrollHeight - sc.clientHeight - 1 : o.dy < 0 ? sc.scrollTop > 0
      : o.dx > 0 ? sc.scrollLeft < sc.scrollWidth - sc.clientWidth - 1 : sc.scrollLeft > 0);
    const target = els.find(can) || document.scrollingElement || document.documentElement;
    try { target.scrollBy({ left: o.dx, top: o.dy, behavior: 'instant' }); } catch { target.scrollBy(o.dx, o.dy); }
    return true;
  }

  // ---- upload_file (SPEC §5.2) -----------------------------------------------------------------
  // tools/upload.js names the target once (uploadTarget), passes the files' bytes in, in pieces
  // (uploadChunk), has the files made and set, or a drop made ready (uploadAssign), then fires the
  // events (uploadDispatch). The page can't see this world, so nothing reaches it before
  // uploadAssign. The bytes are kept for that one upload only (uploadDrop, or the next upload).
  const UPLOAD_MAX = 20 * 1024 * 1024;
  const isFileInput = (el) => !!el && el.nodeType === 1 && el.localName === 'input' && String(el.type).toLowerCase() === 'file';
  let upload = null; // { id, sizes, parts: Uint8Array[][], got: number[], dt }
  const GONE = 'The page navigated or reloaded during the upload, so nothing was given to it.';

  function fileInputs() {
    const out = [];
    for (const d of allDocs()) for (const el of d.querySelectorAll('input[type=file i]')) out.push(el);
    return out;
  }

  function fileInputLine(el) {
    const bits = [];
    const acc = el.getAttribute('accept');
    if (acc) bits.push(`accept=${JSON.stringify(clip(acc, 80))}`);
    if (el.multiple) bits.push('multiple');
    if (el.disabled) bits.push('disabled');
    if (el.webkitdirectory) bits.push('folders');
    bits.push(rendered(el) ? 'visible' : 'hidden');
    const lab = el.labels && [...el.labels].map((l) => norm(l.innerText || '')).find(Boolean);
    if (lab) bits.push(`label ${JSON.stringify(clip(lab, 60))}`);
    return `[${ref(el)}] ${labelIn(el)}: ${bits.join(', ')}`;
  }

  /** File inputs inside el (drop zones usually have one, often hidden). */
  const innerFileInputs = (el) => [...el.querySelectorAll('input[type=file i]')];

  function fileInputList() {
    const all = fileInputs();
    const lines = all.slice(0, 20).map(fileInputLine);
    if (all.length > 20) lines.push(`… and ${all.length - 20} more`);
    return lines;
  }

  /** The origin of a document's realm ('null' if opaque): srcdoc and about:blank frames share their parent's. */
  const realmOrigin = (d) => { try { return String(d.defaultView.origin); } catch { return 'null'; } };

  /** Why a file input can't take `count` files, or null. */
  function inputRefusal(el, count) {
    if (el.disabled) return `${labelIn(el)} is disabled`;
    if (el.webkitdirectory) return `${labelIn(el)} is for choosing a folder, which upload_file doesn't do`;
    if (count > 1 && !el.multiple) return `${labelIn(el)} takes one file (it has no "multiple"), and ${count} were given`;
    return null;
  }

  /** The element the files go to: a file input (or the one a label is for), or with drop, a drop zone. */
  function uploadTarget(o) {
    let el;
    if (o.ref == null && o.selector == null && o.text == null) {
      if (o.drop) return ERR('bad_args', 'Say which element to drop the files on: `ref`, `selector` or `text`.');
      const all = fileInputs();
      if (!all.length) {
        return ERR('no_element', `There is no file input on the page that cctether can reach.${blindNote()} `
          + 'Pages that open a file chooser from a button usually have a hidden one; if it is in another site\'s frame or a closed shadow root, or the page makes it only when clicked, ask the user to choose the file.');
      }
      if (all.length > 1) return ERR('ambiguous', `The page has ${all.length} file inputs, so cctether did not pick one. Pass the ref of the right one:`, fileInputList());
      el = all[0];
    } else {
      el = resolve(o);
      if (el.__error) return el;
    }
    let t = el;
    if (o.drop) {
      if (isFileInput(t)) return ERR('bad_args', `${labelIn(t)} is a file input: pass it without drop (drop is for drop zones).`);
      if (!rendered(t)) return ERR('no_element', `${labelIn(t)} is not visible (hidden or zero size), so it is not a drop zone the user could drop on.`);
    } else {
      if (!isFileInput(t) && t.localName === 'label' && isFileInput(t.control)) t = t.control;
      if (!isFileInput(t)) {
        const inner = innerFileInputs(el);
        if (inner.length === 1) {
          return ERR('no_element', `${labelIn(el)} is not a file input, but it contains one: pass its ref (without drop) to set the files on it:`, [fileInputLine(inner[0])]);
        }
        const list = fileInputList();
        return ERR('no_element', `${labelIn(el)} is not a file input (<input type=file>) or the label of one, so upload_file can't set files on it. `
          + (list.length ? 'These are the file inputs cctether can reach; pass the ref of the right one (or pass drop: true to drop the files on the element instead):' : `The page has no file input cctether can reach.${blindNote()} To drop the files on the element instead, pass drop: true.`),
        list.length ? list : undefined);
      }
      const why = inputRefusal(t, o.count);
      if (why) return ERR('bad_args', `Not done: ${why}.`);
    }
    const inner = o.drop ? innerFileInputs(t) : [];
    return {
      ref: ref(t), doc: docToken, desc: labelIn(t), input: isFileInput(t),
      inner: inner.length === 1 ? ref(inner[0]) : null,
      origin: realmOrigin(t.ownerDocument), top: realmOrigin(document),
      accept: isFileInput(t) ? t.getAttribute('accept') || '' : '',
    };
  }

  function fromBase64(b64) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** Start an upload ({ begin, sizes }) or add a piece of file `file` ({ b64 }). */
  function uploadChunk(o) {
    if (o.doc !== docToken) return ERR('navigated', GONE);
    if (o.begin) {
      upload = null;
      const total = o.sizes.reduce((a, b) => a + b, 0);
      if (!(total <= UPLOAD_MAX)) return ERR('bad_args', 'The files are too large.');
      upload = { id: o.id, sizes: o.sizes, parts: o.sizes.map(() => []), got: o.sizes.map(() => 0), dt: null };
      return true;
    }
    const u = upload;
    if (!u || u.id !== o.id || !u.parts) return ERR('navigated', GONE);
    const bytes = fromBase64(o.b64);
    if (!(o.file >= 0 && o.file < u.sizes.length) || u.got[o.file] + bytes.length > u.sizes[o.file]) {
      upload = null;
      return ERR('internal', 'cctether passed a file into the page wrongly, so nothing was given to it.');
    }
    u.parts[o.file].push(bytes);
    u.got[o.file] += bytes.length;
    return true;
  }

  /**
   * Make the files (in the target's own frame) and set them on the file input, or keep them for
   * the drop. Checks first that it is still the same element, page and site. Fires no events.
   */
  function uploadAssign(o) {
    const u = upload;
    if (!u || u.id !== o.id || !u.parts || o.doc !== docToken) return ERR('navigated', GONE);
    if (u.got.some((g, i) => g !== u.sizes[i])) { upload = null; return ERR('internal', 'Part of a file did not reach the page, so nothing was given to it.'); }
    const el = resolve({ ref: o.ref, doc: o.doc });
    if (el.__error) { upload = null; return ERR('stale_ref', 'The element was removed (or its frame navigated) during the upload, so nothing was given to the page. Find it again, then retry.'); }
    const d = el.ownerDocument;
    if (realmOrigin(d) !== o.origin || realmOrigin(document) !== o.origin) { upload = null; return ERR('navigated', `The page is no longer on ${o.origin}, so nothing was given to it.`); }
    if (isFileInput(el) !== !o.drop) { upload = null; return ERR('stale_ref', 'The element changed during the upload, so nothing was given to the page. Find it again, then retry.'); }
    if (!o.drop) {
      const why = inputRefusal(el, o.files.length);
      if (why) { upload = null; return ERR('bad_args', `Not done: ${why}.`); }
    }
    const W = d.defaultView;
    const dt = new W.DataTransfer();
    const now = Date.now();
    o.files.forEach((f, i) => dt.items.add(new W.File(u.parts[i], f.name, { type: f.type, lastModified: now })));
    u.parts = null; // the files hold the bytes now
    const list = (fl) => [...fl].map((f) => ({ name: f.name, size: f.size, type: f.type }));
    if (o.drop) {
      u.dt = dt;
      return { before: 0, got: list(dt.files) };
    }
    const before = el.files ? el.files.length : 0;
    el.files = dt.files;
    return { before, got: list(el.files || []) };
  }

  /** Fire input and change on the file input, or dragenter, dragover and drop on the drop zone. */
  function uploadDispatch(o) {
    const u = upload;
    upload = null;
    if (!u || u.id !== o.id || o.doc !== docToken) return ERR('navigated', 'The page navigated or reloaded before the events were fired.');
    const el = resolve({ ref: o.ref, doc: o.doc });
    if (el.__error) return ERR('stale_ref', 'The element was removed before the events were fired.');
    const W = el.ownerDocument.defaultView;
    if (!o.drop) {
      el.dispatchEvent(new W.Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new W.Event('change', { bubbles: true }));
      return { after: el.files ? el.files.length : 0, connected: el.isConnected };
    }
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: u.dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new W.DragEvent('dragenter', init));
    const over = el.dispatchEvent(new W.DragEvent('dragover', init));
    const drop = el.dispatchEvent(new W.DragEvent('drop', init));
    // dispatchEvent is false when a listener called preventDefault: the page took part.
    return { accepted: !over, handled: !drop };
  }

  /** Forget the bytes of upload o.id (it stopped). */
  function uploadDrop(o) {
    if (upload && upload.id === o.id) upload = null;
    return true;
  }

  const api = {
    readText, interactive, html, find, point, pointNow, pressCheck, at, elementRect, metrics, shotCheck, scrollPageTo,
    dragWatch, dragResult,
    uploadTarget, uploadChunk, uploadAssign, uploadDispatch, uploadDrop,
    focus, focusedOn, active, checkFocus, selectAllInFocused, focusedLength, forceClear, valueOf, selectOption,
    ddTarget, ddOptions, ddPick, ddFinal, ddShown, ddSettling, visibleOptions,
    scrollerInfo, scrollerStep, scrollerRestore, mainScroller,
    waitCheck,
    scrollState, scrollTo, scrollByJs,
  };
  // What one call worked out about frames and positions is kept for that call only.
  for (const k of Object.keys(api)) {
    const f = api[k];
    api[k] = (...a) => {
      try { return f(...a); } finally { cache = {}; }
    };
  }
  return api;
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
  // Nodes of a frame's document come from another realm, where instanceof Node fails: ask Node's
  // own nodeType getter, which only works on real nodes (of any realm of this page).
  const nodeTypeOf = typeof Node === 'function' ? Object.getOwnPropertyDescriptor(Node.prototype, 'nodeType')?.get : null;
  const isNode = (v) => {
    if (typeof Node === 'function' && v instanceof Node) return true;
    if (!nodeTypeOf || v === null || typeof v !== 'object') return false;
    try { nodeTypeOf.call(v); return true; } catch (e) { return false; }
  };
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

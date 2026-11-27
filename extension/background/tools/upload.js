// upload_file (SPEC §5.2): give files the service sent (it read them from its uploads directory)
// to a file input on the page, or drop them on a drop zone. The page gets synthetic events
// (isTrusted false); most pages and upload widgets take them.
//
// The target is named once and checked again right before the files are given: same tab, same
// debugger session, same document and element, still on the site Claude named, still shared,
// not paused, no dialog, in time. Nothing that happens before that point reaches the page: the
// bytes go into cctether's own isolated world, which the page can't see.

import { ToolError } from './errors.js';
import { q, fmtBytes } from './util.js';
import { isShared } from '../tabs.js';
import { describeDialog, dialogHint, isContextGone } from '../debugger.js';
import { tabSummary } from './browser.js';
import { settle } from './input.js';

/** The most bytes of all files of one call (as the service, server/src/uploads.js). */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;
/** From receiving the call; the service waits longer (server/src/tools.js uploadTimeoutMs). */
const UPLOAD_BUDGET_MS = 30_000;
/** Base64 characters passed into the page per command (a multiple of 4). */
const CHUNK = 1_000_000;

const bad = (m) => new ToolError('bad_args', m);
const text = (t) => ({ type: 'text', text: t });

const b64Size = (b64) => (b64.length / 4) * 3 - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

/** Argument check for `files` as the service sends them: [{ name, type, data (base64) }]. */
export const uploadFiles = () => (v, k) => {
  if (!Array.isArray(v) || !v.length || v.length > MAX_FILES) throw bad(`\`${k}\` must be a list of 1–${MAX_FILES} files.`);
  let total = 0;
  v.forEach((f, i) => {
    const at = `\`${k}[${i}]\``;
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad(`${at} must be an object.`);
    for (const key of Object.keys(f)) if (!['name', 'type', 'data'].includes(key)) throw bad(`Unknown field \`${key}\` in ${at}.`);
    if (typeof f.name !== 'string' || !f.name || f.name.length > 255 || f.name.startsWith('.') || /[\u0000-\u001f\u007f-\u009f/\\]/.test(f.name)) {
      throw bad(`${at}.name is not a plain file name.`);
    }
    if (typeof f.type !== 'string' || f.type.length > 200 || !/^(?:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)?$/.test(f.type)) throw bad(`${at}.type is not a MIME type.`);
    if (typeof f.data !== 'string' || f.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) throw bad(`${at}.data is not base64.`);
    total += b64Size(f.data);
  });
  if (total > UPLOAD_MAX_BYTES) throw bad(`The files are larger than ${UPLOAD_MAX_BYTES / 1048576} MiB in all.`);
};

/** The web origin Claude named ("https://example.com", or any URL of the site). */
function wantedOrigin(s) {
  let u;
  try { u = new URL(s); } catch { throw bad(`\`origin\` must be the site's address, like "https://example.com"; got ${q(s, 100)}.`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad('`origin` must be an http or https address, like "https://example.com".');
  return u.origin;
}

function originOf(url) {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? null : o;
  } catch { return null; }
}

/** Does a file fail the input's accept list ("image/*,.pdf")? An empty list takes anything. */
function notAccepted(accept, f) {
  const toks = accept.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!toks.length) return false;
  const name = f.name.toLowerCase();
  const type = f.type.toLowerCase();
  return !toks.some((t) => (t.startsWith('.') ? name.endsWith(t) : t.endsWith('/*') ? type.startsWith(t.slice(0, -1)) : type === t));
}

let uploading = false;

export async function uploadFile({ tab, s, startedAt = Date.now(), paused = () => false }, args) {
  const want = wantedOrigin(args.origin);
  const files = args.files;
  const n = files.length;
  if (uploading) throw new ToolError('busy', 'Another upload is in progress in this browser. Try again when it is done.');
  uploading = true;
  const deadline = startedAt + UPLOAD_BUDGET_MS;
  const left = () => Math.max(1, Math.min(10000, deadline - Date.now()));
  const id = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
  const w = s.navWatch();
  // A dialog seen during the upload stays seen, even if handle_dialog closes it meanwhile.
  let dialog = s.dialog;
  const offDialog = s.on((m) => { if (m === 'Page.javascriptDialogOpening') dialog ??= s.dialog; });
  let staged = false;
  let given = false;

  /** A page library call that must stay in this document: never tried again in a new one. */
  const lib = async (fn, a) => {
    try {
      return await s.lib(fn, a, { retry: false, timeoutMs: left() });
    } catch (e) {
      if (isContextGone(e)) throw new ToolError('navigated', 'The page navigated or reloaded during the upload, so nothing was given to it.');
      throw e;
    }
  };
  const blockedNow = () => {
    if (s.closed) return 'cctether no longer has the tab (it left the cctether group, or was paused or closed)';
    if (paused()) return 'cctether was paused';
    if (dialog) return `${describeDialog(dialog)} opened`;
    if (w.st.committed) return 'the page navigated';
    if (Date.now() > deadline) return `it took longer than ${UPLOAD_BUDGET_MS / 1000} s`;
    return null;
  };
  const stop = (why) => {
    const lines = [`Not done: ${why}, so nothing was given to the page.`];
    if (dialog && s.dialog) lines.push(dialogHint(s.dialog));
    return new ToolError(dialog ? 'dialog_open' : w.st.committed ? 'navigated' : Date.now() > deadline ? 'timeout' : 'not_shared', lines.join(' '));
  };

  try {
    const before = (await tabSummary(tab.id)).url;
    const shown = originOf(before);
    if (shown !== want) {
      throw bad(`Not done: tab ${tab.id} shows ${shown ?? 'a page with no web origin'}, not ${want}, so nothing was given to it. Check that the tab shows the site the files are meant for.`);
    }
    const t = await lib('uploadTarget', [{ ref: args.ref, selector: args.selector, text: args.text, drop: args.drop === true, count: n }]);
    if (t.origin !== want || t.top !== want) {
      throw bad(`Not done: ${t.desc} is on ${t.origin === want ? t.top : t.origin}, not ${want}, so nothing was given to it.`);
    }

    // The bytes, into this upload's own store in cctether's world.
    await lib('uploadChunk', [{ id, doc: t.doc, begin: true, sizes: files.map((f) => b64Size(f.data)) }]);
    staged = true;
    for (let i = 0; i < n; i++) {
      const data = files[i].data;
      for (let off = 0; off < data.length; off += CHUNK) {
        const why = blockedNow();
        if (why) throw stop(why);
        await lib('uploadChunk', [{ id, doc: t.doc, file: i, b64: data.slice(off, off + CHUNK) }]);
      }
    }

    // The last checks, after any pending check of the tab's sharing (and again if another one
    // started meanwhile): nothing else is awaited between them and giving the files.
    for (;;) {
      while (s.scopeCheck) await s.scopeCheck;
      const gen = s.scopeGen;
      let now = null;
      try { now = await chrome.tabs.get(tab.id); } catch { /* closed */ }
      let why = blockedNow();
      if (!why && !(await isShared(now))) why = 'the tab left the cctether group';
      if (!why && originOf(now.url) !== want) why = `the tab now shows ${originOf(now.url) ?? 'a page with no web origin'}`;
      if (why) throw stop(why);
      if (s.scopeCheck || s.scopeGen !== gen) continue;
      break;
    }

    const meta = files.map((f) => ({ name: f.name, type: f.type }));
    let a;
    try {
      a = await s.lib('uploadAssign', [{ id, doc: t.doc, ref: t.ref, origin: want, drop: args.drop === true, files: meta }], { retry: false, timeoutMs: left() });
    } catch (e) {
      if (e?.fromPage) throw e; // the library answered: it says what happened
      // The command went out without a clear answer (timeout, the page went, a dialog, an
      // exception): the page may have the files. Not tried again.
      throw new ToolError(e?.code === 'timeout' ? 'timeout' : 'internal', `No clear answer came while the files were being given to the page (${e?.message ?? e}). `
        + 'They may have been given: check the page (screenshot or read_page) before trying again, so that they are not given twice.');
    }
    const sizes = files.map((f) => b64Size(f.data));
    const same = a.got.length === n && a.got.every((g, i) => g.name === meta[i].name && g.size === sizes[i] && g.type === meta[i].type);
    if (!same) {
      throw new ToolError('internal', `The ${args.drop ? 'files made for the drop' : 'file input'} ended up with other files than were given `
        + `(${a.got.map((g) => `${q(g.name, 60)} ${g.size} B ${g.type || 'no type'}`).join(', ') || 'none'}), so no events were fired. Check the page.`);
    }
    given = true;

    const list = files.map((f, i) => `${q(f.name, 120)} (${fmtBytes(sizes[i])}, ${f.type || 'no type'})`).join(', ');
    const them = n === 1 ? 'it' : 'them';
    const lines = [];
    const r = await s.raceDialog(lib('uploadDispatch', [{ id, doc: t.doc, ref: t.ref, drop: args.drop === true }]).then((v) => ({ ok: v }), (e) => ({ err: e })));
    if (args.drop) {
      lines.push(`Dropped ${n === 1 ? 'the file' : `${n} files`} ${list} on ${t.desc} on ${want}: fired dragenter, dragover and drop with ${them} (synthetic events).`);
    } else {
      lines.push(`Gave ${n === 1 ? 'the file' : `${n} files`} ${list} to ${t.desc} on ${want}`
        + `${a.before ? `, replacing the ${a.before === 1 ? 'file' : `${a.before} files`} chosen there before` : ''}, and fired input and change on it (synthetic events: a page that only accepts a real user's choice ignores them).`);
    }
    if (r.dialog) {
      lines.push(`While handling the events, the page opened ${describeDialog(r.dialog)}. ${dialogHint(r.dialog)}`);
    } else if (r.value.err) {
      const e = r.value.err;
      lines.push(`But firing the events failed (${e.message}): the page may not have noticed the files. Check the page.`);
    } else {
      const d = r.value.ok;
      if (args.drop) {
        lines.push(d.handled ? 'The page handled the drop (it called preventDefault on it).' : 'The page did not call preventDefault on the drop, so it may not have taken the files.');
        // Some widgets (react-dropzone) read dropped files in a way a synthetic drop can't serve.
        if (t.inner != null) lines.push(`If it did not take them, set them on the file input inside the drop zone instead: ref ${t.inner}, without drop.`);
      } else if (!d.connected) {
        lines.push('The page removed the input right after (some upload widgets replace it).');
      } else if (d.after === 0) {
        lines.push('The page emptied the input right after: normal for upload widgets that take the files at once.');
      }
      const note = await settle(s, w, tab.id, before);
      if (note) lines.push(note);
    }
    if (t.accept) {
      const off = files.filter((f) => notAccepted(t.accept, f));
      if (off.length) lines.push(`Note: the input's accept list is ${q(t.accept, 100)}, which ${off.map((f) => q(f.name, 80)).join(', ')} ${off.length === 1 ? 'does' : 'do'} not match: the page may refuse ${off.length === 1 ? 'it' : 'them'}.`);
    }
    lines.push(`Check what the page did with ${them} (screenshot or read_page).`);
    return { content: [text(lines.join(' '))] };
  } finally {
    offDialog();
    w.stop();
    uploading = false;
    if (staged && !given && !s.closed) s.lib('uploadDrop', [{ id }], { retry: false, timeoutMs: 2000 }).catch(() => {});
  }
}

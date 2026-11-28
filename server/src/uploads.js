// upload_file (SPEC §5.2): the service reads the files from cctether's own uploads directory and
// sends their contents to the extension, which gives them to a file input on the page. Only that
// directory: taking any path would let Claude push any file on this computer (keys, configs,
// files Claude Code's own permissions keep it from reading) to a website. Claude copies a file
// in first, which Claude Code's permissions do govern.
//
// Stricter than evaluate's `file` (evalfile.js): a name, not a path; no links, no hard links;
// the directories above must not be changeable by other users (so nothing can be swapped
// between the checks and the open); the opened file is checked again, and read to its size.

import { constants } from 'node:fs';
import { open, lstat, stat, statfs, realpath, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { ensurePrivateDir } from './evalfile.js';

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024; // all files of one call together
export const UPLOAD_MAX_FILES = 10;
const NAME_MAX_BYTES = 255;

/**
 * `info`, when the uploads directory itself is the problem: { code, level?, path?, dev?, ino? }
 * for setup and check (see uploadsDirStatus). Claude gets only the message.
 */
export class UploadError extends Error {
  constructor(message, info = null) {
    super(message);
    this.info = info;
  }
}

const fail = (m, info) => { throw new UploadError(m, info); };

export const uploadsDir = (configDir) => join(configDir, 'uploads');
export const ensureUploadsDir = ensurePrivateDir;

/** MIME types by extension; anything else is application/octet-stream. */
const MIME = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.avif': 'image/avif', '.heic': 'image/heic', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tgz': 'application/gzip', '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.epub': 'application/epub+zip', '.rtf': 'application/rtf',
};

export function mimeType(name) {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** Why `name` is not a plain file name upload_file takes, or null. */
export function badName(name) {
  if (typeof name !== 'string' || name === '') return 'is empty';
  if (!name.isWellFormed()) return 'is not valid text';
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return 'contains a control character';
  if (/[/\\]/.test(name)) return 'is a path: pass just the file name (files are read from the uploads directory only)';
  if (name.startsWith('.')) return 'starts with "." (hidden files are not uploaded)';
  if (Buffer.byteLength(name) > NAME_MAX_BYTES) return 'is too long';
  return null;
}

const uid = () => (process.getuid ? process.getuid() : null);

// Who owns a file, as far as this process can tell. A systemd user service with ProtectSystem= or
// PrivateTmp= (cctether setup writes one) runs in a user namespace that maps only its own user:
// there every other owner, root included, shows as the overflow id ("nobody", usually 65534).

/** Parse /proc/self/uid_map into [{ inside, count }], or null if it doesn't look like one. */
export function parseUidMap(text) {
  const map = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const f = line.trim().split(/\s+/);
    if (f.length !== 3 || !f.every((x) => /^\d+$/.test(x))) return null;
    map.push({ inside: Number(f[0]), count: Number(f[2]) });
  }
  return map.length ? map : null;
}

const mapsId = (map, id) => map.some((r) => id >= r.inside && id < r.inside + r.count);
const ALL_IDS = 4294967295; // 0 … 2^32-2; outside any user namespace, uid_map is "0 0 4294967295"

/**
 * { partial, rootMapped, overflow } from the texts of /proc/self/uid_map and
 * /proc/sys/kernel/overflowuid (null when unreadable). partial: some ids are not mapped, so files
 * of those owners show as `overflow`. overflow is null when it can't be read; then no owner counts
 * as unknown. Without a uid_map (macOS, or unreadable): everything is mapped, as before.
 */
export function idView({ uidMap, overflow }) {
  const map = uidMap == null ? null : parseUidMap(uidMap);
  if (!map) return { partial: false, rootMapped: true, overflow: null };
  const covered = map.reduce((n, r) => n + r.count, 0);
  const o = overflow != null && /^\d+$/.test(String(overflow).trim()) ? Number(String(overflow).trim()) : null;
  return { partial: covered < ALL_IDS, rootMapped: mapsId(map, 0), overflow: o };
}

async function readIdView() {
  if (process.platform !== 'linux') return idView({ uidMap: null, overflow: null });
  const read = (p) => readFile(p, 'utf8').catch(() => null);
  const [uidMap, overflow] = await Promise.all([read('/proc/self/uid_map'), read('/proc/sys/kernel/overflowuid')]);
  return idView({ uidMap, overflow });
}

/**
 * 'me', 'root', 'unknown' (an owner this namespace doesn't map: root or another user, can't tell
 * which; also the overflow id when it is mapped too, as that is ambiguous) or 'other'. Uid 0
 * only counts as root when root is mapped here.
 */
export function ownerKind(fileUid, me, view) {
  if (view.partial && view.overflow !== null && fileUid === view.overflow) return 'unknown';
  if (me !== null && fileUid === me) return 'me';
  if (fileUid === 0 && view.rootMapped) return 'root';
  return 'other';
}

/**
 * The directories above this user's home directory (from the password database, resolved), when
 * the resolved uploads directory `real` is inside that home and the home is this user's: an
 * unknown owner of one of these can be trusted, because whoever owns a directory above your home
 * can replace the whole home (shell profile, Claude Code's settings, cctether's key) anyway.
 * Empty when owners can't be unknown here, or anything about the home can't be established.
 */
async function aboveHome(real, view, homeDir) {
  const none = new Set();
  if (!view.partial || view.overflow === null) return none;
  let home = homeDir;
  if (home === undefined) {
    try { home = userInfo().homedir; } catch { return none; }
  }
  if (typeof home !== 'string' || !isAbsolute(home)) return none;
  let realHome;
  try {
    realHome = await realpath(home);
    const st = await lstat(realHome);
    if (!st.isDirectory() || ownerKind(st.uid, uid(), view) !== 'me') return none;
  } catch {
    return none;
  }
  const rel = relative(realHome, real);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return none;
  const above = new Set();
  for (let d = realHome; d !== dirname(d);) {
    d = dirname(d);
    above.add(d);
  }
  return above;
}

// Messages name "the uploads directory" (its path is in the tool's description), not the path.
const MISSING = 'The uploads directory does not exist (cctether makes it when it starts, mode 700). Create it, copy the files into it, then try again.';
const NOT_PRIVATE = 'The uploads directory is not a private directory of this user (it is a link, or others can use it), so upload_file is off. Make it a plain directory with mode 700.';

/**
 * lstat of a directory of this user that nobody else can use (not a link); fails otherwise.
 * BigInt, so that device and inode numbers compare exactly (inodes can be above 2^53).
 */
async function privateStat(dir, view) {
  let st;
  try {
    st = await lstat(dir, { bigint: true });
  } catch (e) {
    missing(e);
  }
  const me = uid();
  if (!st.isDirectory() || (me !== null && ownerKind(Number(st.uid), me, view) !== 'me') || (Number(st.mode) & 0o077) !== 0) fail(NOT_PRIVATE, { code: 'not_private' });
  return st;
}

/** The uploads directory couldn't be looked at: missing, or something else (no permission, say). */
function missing(e) {
  if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') fail(MISSING, { code: 'missing' });
  fail(`Can't check the uploads directory (${e?.code || 'error'}).`, { code: 'cant_check' });
}

const sameDir = (a, b) => a.dev === b.dev && a.ino === b.ino; // both BigInt stats

/**
 * { real, st, relaxed }: the real path of the uploads directory, its lstat, and whether a directory
 * above passed only as an unknown owner above the home (then the files must be opened through
 * the checked directory, see bindDir), after checking that it is a private directory of this
 * user, that no directory above the resolved path can be changed by another user (root's and
 * this user's own are fine, and so are sticky ones like /tmp, where others can't rename what
 * isn't theirs), and that the resolved path is that very directory (same device and inode: a
 * directory above may have been swapped meanwhile). Then nobody else can swap anything on the
 * path the files are opened by. In a sandbox where root's directories show an unknown owner (see
 * ownerKind), those above this user's home directory count as root's (see aboveHome).
 */
async function checkedDir(dir, view, homeDir) {
  const first = await privateStat(dir, view);
  let real;
  try {
    real = await realpath(dir);
  } catch (e) {
    missing(e);
  }
  // From the root down: each directory above must be root's or this user's, and not open to
  // others' changes. Then the directory itself must still be the one checked first.
  const above = [];
  for (let d = dirname(real); ; d = dirname(d)) {
    above.unshift(d);
    if (d === dirname(d)) break;
  }
  const me = uid();
  const trusted = await aboveHome(real, view, homeDir);
  let relaxed = false;
  for (const d of above) {
    let st;
    try {
      st = await lstat(d, { bigint: true });
    } catch (e) {
      fail(`Can't check a directory above the uploads directory (${e.code || 'error'}).`, { code: 'cant_check' });
    }
    const n = relative(d, real).split(sep).length;
    const where = `The directory ${n} level${n === 1 ? '' : 's'} above the uploads directory`;
    const info = (code) => ({ code, level: n, path: d, dev: String(st.dev), ino: String(st.ino) });
    const mode = Number(st.mode);
    const kind = ownerKind(Number(st.uid), me, view);
    const owner = me === null || kind === 'me' || kind === 'root' || (kind === 'unknown' && trusted.has(d));
    // Writable by the group is refused too, even when the group is this user's own (Debian and
    // Ubuntu's umask 002 makes ~/.config so): who else can write can't be told reliably (ACLs,
    // LDAP, supplementary groups a process kept). The message says which directory, to fix it.
    const othersWrite = (mode & 0o022) !== 0 && (mode & 0o1000) === 0;
    if (st.isDirectory() && !othersWrite && kind === 'unknown' && !owner) {
      fail(`${where} belongs to an owner this service can't see (it runs in a sandbox, such as the background service's, that only knows its own user), so upload_file is off: files there could be swapped while being read. Keep cctether's configuration directory inside your home directory.`, info('above_unknown'));
    }
    if (!st.isDirectory() || !owner || othersWrite) {
      fail(`${where} can be changed by another user (or is not a directory of this user or root), so upload_file is off: files there could be swapped while being read. If it is yours, make it writable only by you (chmod go-w).`,
        info(!st.isDirectory() ? 'above_not_dir' : !owner ? 'above_owner' : 'above_writable'));
    }
    if (me !== null && kind === 'unknown') relaxed = true;
  }
  const resolved = await privateStat(real, view);
  if (!sameDir(resolved, first)) fail(CHANGED, { code: 'changed' });
  return { real, st: resolved, relaxed };
}

const CHANGED = 'The uploads directory changed while it was being checked. Try again.';

const PROC_SUPER_MAGIC = 0x9fa0;
const CANT_BIND = 'upload_file is off: this service runs in a sandbox where it can\'t tell who owns the directories above your home, and it can\'t open the files through the directory it checked (/proc/self/fd isn\'t usable here, or the uploads directory isn\'t readable: it should be mode 700).';

/**
 * On Linux, a handle on the directory just checked (same device and inode), through which the files
 * are opened: /proc/self/fd/<n>/<name> resolves from that very directory, like openat, so nothing
 * done to the path after the checks can redirect the opens. Where that isn't available (macOS;
 * Linux without procfs; a directory this user may enter but not read), null: the files are
 * opened by the checked path, as in 0.8.0. But not after a relaxed check (see checkedDir): then
 * the binding is what makes it safe, so no binding means no upload.
 */
async function bindDir(real, checked, relaxed) {
  const without = () => (relaxed ? fail(CANT_BIND, { code: 'cant_bind' }) : null);
  if (process.platform !== 'linux' || constants.O_DIRECTORY === undefined) return without();
  let fh;
  try {
    fh = await open(real, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ELOOP' || e.code === 'ENOTDIR') fail(CHANGED, { code: 'changed' });
    return without();
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!sameDir(st, checked)) fail(CHANGED, { code: 'changed' });
    const path = `/proc/self/fd/${fh.fd}`;
    // The fd folder itself is procfs (statfs of the link would report the uploads directory's).
    const fs = await statfs('/proc/self/fd').catch(() => null);
    const via = fs?.type === PROC_SUPER_MAGIC ? await stat(path, { bigint: true }).catch(() => null) : null;
    if (!via || !sameDir(via, checked)) {
      await fh.close();
      return without();
    }
    return fh;
  } catch (e) {
    await fh.close().catch(() => {});
    if (e instanceof UploadError) throw e;
    fail(`Can't check the uploads directory (${e.code || 'error'}).`, { code: 'cant_check' });
  }
}

/**
 * Whether upload_file can use the uploads directory now, by the same checks, as this process sees
 * it (the service may run in a sandbox): { ok: true, dir } with the resolved path, or { ok: false,
 * code, level?, path?, dev?, ino?, message } (dev and ino as strings). For setup and check
 * (SPEC §8.2). `homeDir` and `view` are for tests.
 */
export async function uploadsDirStatus(dir, { homeDir, view } = {}) {
  try {
    const ids = view ?? await readIdView();
    const { real, st, relaxed } = await checkedDir(dir, ids, homeDir);
    const fh = await bindDir(real, st, relaxed);
    await fh?.close().catch(() => {});
    // Claude copies files in (write) and the service opens them by name (search): reading the
    // directory's list isn't needed.
    if ((Number(st.mode) & 0o300) !== 0o300) {
      return {
        ok: false, code: 'not_usable', path: real, dev: String(st.dev), ino: String(st.ino),
        message: 'The uploads directory can\'t be used by its owner: files can\'t be copied into it or opened (its mode should be 700).',
      };
    }
    return { ok: true, dir: real };
  } catch (e) {
    if (e instanceof UploadError) return { ok: false, code: e.info?.code ?? 'cant_check', ...e.info, message: e.message };
    return { ok: false, code: 'cant_check', message: `Can't check the uploads directory (${e.code || 'error'}).` };
  }
}

/**
 * Read the files `names` from the uploads directory `dir`, all checked before any is returned.
 * Returns [{ name, type, bytes }]. Throws UploadError with a message for Claude, never with file
 * contents. `homeDir`, `view` and `afterCheck` are for tests (default: the password database, /proc).
 */
export async function readUploads(names, dir, { maxBytes = UPLOAD_MAX_BYTES, homeDir, view, afterCheck } = {}) {
  if (!Array.isArray(names) || !names.length) fail('Pass at least one file name in `files`.');
  if (names.length > UPLOAD_MAX_FILES) fail(`At most ${UPLOAD_MAX_FILES} files at a time.`);
  const seen = new Set();
  for (const n of names) {
    const why = badName(n);
    if (why) fail(`The file name ${JSON.stringify(String(n).slice(0, 100))} ${why}.`);
    if (seen.has(n)) fail(`${JSON.stringify(n)} is in \`files\` twice.`);
    seen.add(n);
  }
  const ids = view ?? await readIdView();
  const { real, st: checked, relaxed } = await checkedDir(dir, ids, homeDir);
  const dirFh = await bindDir(real, checked, relaxed);
  try {
    await afterCheck?.();
    return await readAll(names, dirFh ? `/proc/self/fd/${dirFh.fd}` : real, ids, maxBytes);
  } finally {
    await dirFh?.close().catch(() => {});
  }
}

async function readAll(names, at, ids, maxBytes) {
  const me = uid();
  const out = [];
  let left = maxBytes;
  for (const name of names) {
    const p = join(at, name);
    let fh;
    try {
      // O_NOFOLLOW: no link (also one put there after the checks); O_NONBLOCK: a FIFO doesn't
      // block the open (fstat then refuses it).
      fh = await open(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0));
    } catch (e) {
      if (e.code === 'ENOENT') fail(`There is no file ${JSON.stringify(name)} in the uploads directory. Copy it there first.`);
      if (e.code === 'ELOOP' || e.code === 'EMLINK') fail(`${JSON.stringify(name)} in the uploads directory is a link, which upload_file doesn't take. Copy the file itself there.`);
      fail(`Can't open ${JSON.stringify(name)} in the uploads directory (${e.code || 'error'}).`);
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) fail(`${JSON.stringify(name)} in the uploads directory is not a regular file.`);
      if (me !== null && ownerKind(st.uid, me, ids) !== 'me') fail(`${JSON.stringify(name)} in the uploads directory belongs to another user.`);
      if (st.nlink !== 1) fail(`${JSON.stringify(name)} in the uploads directory has other hard links, which upload_file doesn't take. Copy the file there instead of linking it.`);
      const tooBig = () => fail(`The files are larger than ${maxBytes / 1048576} MiB in all, the most upload_file takes at a time.`);
      if (st.size > left) tooBig();
      // From the opened file, at most one byte more than is left (it may grow meanwhile).
      const buf = Buffer.alloc(Math.min(left, st.size) + 1);
      let n = 0;
      while (n < buf.length) {
        const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
        if (!bytesRead) break;
        n += bytesRead;
      }
      if (n > left) tooBig();
      if (n !== st.size) fail(`${JSON.stringify(name)} changed while it was being read. Try again once it is complete.`);
      left -= n;
      out.push({ name, type: mimeType(name), bytes: buf.subarray(0, n) });
    } finally {
      await fh.close().catch(() => {});
    }
  }
  return out;
}

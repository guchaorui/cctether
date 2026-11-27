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
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { ensurePrivateDir } from './evalfile.js';

export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024; // all files of one call together
export const UPLOAD_MAX_FILES = 10;
const NAME_MAX_BYTES = 255;

export class UploadError extends Error {}

const fail = (m) => { throw new UploadError(m); };

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

// Messages name "the uploads directory" (its path is in the tool's description), not the path.
const MISSING = 'The uploads directory does not exist (cctether makes it when it starts, mode 700). Create it, copy the files into it, then try again.';
const NOT_PRIVATE = 'The uploads directory is not a private directory of this user (it is a link, or others can use it), so upload_file is off. Make it a plain directory with mode 700.';

/** lstat of a directory of this user that nobody else can use (not a link); fails otherwise. */
async function privateStat(dir) {
  let st;
  try {
    st = await lstat(dir);
  } catch {
    fail(MISSING);
  }
  const me = uid();
  if (!st.isDirectory() || (me !== null && st.uid !== me) || (st.mode & 0o077) !== 0) fail(NOT_PRIVATE);
  return st;
}

/**
 * The real path of the uploads directory, after checking that it is a private directory of this
 * user, that the path resolves to that very directory (same device and inode: a directory above
 * may have been swapped meanwhile), and that no directory above the resolved one can be changed
 * by another user (root's and this user's own are fine, and so are sticky ones like /tmp, where
 * others can't rename what isn't theirs). Then nobody else can swap anything on the path the
 * files are opened by.
 */
async function checkedDir(dir) {
  const first = await privateStat(dir);
  let real;
  try {
    real = await realpath(dir);
  } catch {
    fail(MISSING);
  }
  const resolved = await privateStat(real);
  if (resolved.dev !== first.dev || resolved.ino !== first.ino) fail('The uploads directory changed while it was being checked. Try again.');
  const me = uid();
  for (let d = dirname(real); ; d = dirname(d)) {
    let st;
    try {
      st = await lstat(d);
    } catch (e) {
      fail(`Can't check a directory above the uploads directory (${e.code || 'error'}).`);
    }
    const owner = me === null || st.uid === 0 || st.uid === me;
    const othersWrite = (st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0;
    if (!st.isDirectory() || !owner || othersWrite) {
      fail('A directory above the uploads directory can be changed by another user (or is not a directory of this user or root), so upload_file is off: files there could be swapped while being read. Check the permissions of the directories above it.');
    }
    if (d === dirname(d)) break;
  }
  return real;
}

/**
 * Read the files `names` from the uploads directory `dir`, all checked before any is returned.
 * Returns [{ name, type, bytes }]. Throws UploadError with a message for Claude, never with file
 * contents.
 */
export async function readUploads(names, dir, { maxBytes = UPLOAD_MAX_BYTES } = {}) {
  if (!Array.isArray(names) || !names.length) fail('Pass at least one file name in `files`.');
  if (names.length > UPLOAD_MAX_FILES) fail(`At most ${UPLOAD_MAX_FILES} files at a time.`);
  const seen = new Set();
  for (const n of names) {
    const why = badName(n);
    if (why) fail(`The file name ${JSON.stringify(String(n).slice(0, 100))} ${why}.`);
    if (seen.has(n)) fail(`${JSON.stringify(n)} is in \`files\` twice.`);
    seen.add(n);
  }
  const real = await checkedDir(dir);
  const me = uid();
  const out = [];
  let left = maxBytes;
  for (const name of names) {
    const p = join(real, name);
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
      if (me !== null && st.uid !== me) fail(`${JSON.stringify(name)} in the uploads directory belongs to another user.`);
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

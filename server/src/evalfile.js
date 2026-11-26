// evaluate's `file` argument (SPEC §5.2): the service reads a .js file from cctether's own
// scripts directory and sends its text as `expression`. Only that directory: it holds just the
// scripts Claude wrote there for the browser, so `file` can't be used to push other files on this
// computer (keys, configs, files Claude Code's own permissions keep it from reading) into a page.

import { mkdirSync, constants } from 'node:fs';
import { open, realpath, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const FILE_MAX_BYTES = 200 * 1024;
export const FILE_MAX_CHARS = 200_000; // the same limit as `expression`

export class EvalFileError extends Error {}

const fail = (m) => { throw new EvalFileError(m); };

export const scriptsDir = (configDir) => join(configDir, 'scripts');

/**
 * Create the scripts directory (private to the user) if it isn't there. One that is there is
 * left as it is, whatever it is: making a directory others could write to private now would
 * make the scripts they put there earlier look trusted. Reading checks it.
 */
export function ensureScriptsDir(dir) {
  try {
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    // Not recursive: if anything (a link put there meanwhile) is in the way, EEXIST, and it is
    // left alone. No chmod by path, which would follow such a link; the umask only takes bits away.
    mkdirSync(dir, { mode: 0o700 });
  } catch { /* there already, or reported when a file is read from it */ }
}

/** Is dir itself (not a link to one) a directory of this user that nobody else can use? */
async function privateDir(dir) {
  try {
    const st = await lstat(dir);
    return st.isDirectory() && (process.getuid ? st.uid === process.getuid() : true) && (st.mode & 0o077) === 0;
  } catch {
    return null;
  }
}

/** The path below root as segments, or null if p is not inside root (or is root). */
function below(root, p) {
  const rel = relative(root, p);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep);
}

/**
 * Read the script `file` names: a name (or path) in the scripts directory `dir`. Returns
 * { path, text }. Throws EvalFileError with a message for Claude, never with file contents.
 */
export async function readEvalFile(file, dir) {
  if (typeof file !== 'string' || !file.trim()) fail('`file` is empty.');
  if (file.includes('\0')) fail('`file` contains a NUL character.');
  let p = file;
  if (p === '~' || p.startsWith('~/')) p = join(homedir(), p.slice(1));
  p = resolve(dir, p);
  if (!p.endsWith('.js')) fail(`${JSON.stringify(file)} is not a .js file: \`file\` takes a JavaScript file (a browser script, run like \`expression\`).`);
  const ok = await privateDir(dir);
  if (ok === null) fail(`The scripts directory ${dir} does not exist. Write the script there first (the directory may need to be created).`);
  // A link would make "the scripts directory" whatever it points to (a project, a home).
  if (!ok) fail(`The scripts directory ${dir} is not a private directory of this user (it is a link, or others can use it), so \`file\` is off. Make it a plain directory with mode 700, or pass the script as \`expression\`.`);
  let root;
  try {
    root = await realpath(dir);
  } catch {
    fail(`The scripts directory ${dir} does not exist. Write the script there first (the directory may need to be created).`);
  }
  let real;
  try {
    real = await realpath(p);
  } catch (e) {
    fail(e.code === 'ENOENT' ? `There is no file ${p}. Write the script into ${dir} first.` : `Can't open ${p} (${e.code || 'error'}).`);
  }
  const segs = below(root, real);
  if (!segs) fail(`${p} is not in cctether's scripts directory, ${dir}: \`file\` reads only from there. Put the script there.`);
  if (!real.endsWith('.js')) fail(`${p} links to a file that is not a .js file.`);
  if (segs.some((x) => x.startsWith('.'))) fail(`${p} is hidden (a name starting with "."), which \`file\` doesn't read.`);
  let fh;
  try {
    // O_NOFOLLOW: the file can't have been swapped for a link after the checks; O_NONBLOCK: a
    // FIFO put there doesn't block the open (fstat then refuses it).
    fh = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    fail(`Can't open ${p} (${e.code || 'error'}).`);
  }
  let bytes;
  try {
    const st = await fh.stat();
    if (!st.isFile()) fail(`${p} is not a regular file.`);
    if (st.size > FILE_MAX_BYTES) fail(`${p} is ${Math.round(st.size / 1024)} KB; \`file\` takes at most ${FILE_MAX_BYTES / 1024} KB.`);
    // At most one byte more than the limit, from the opened file (it may grow meanwhile).
    const buf = Buffer.alloc(FILE_MAX_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (!bytesRead) break;
      n += bytesRead;
    }
    if (n > FILE_MAX_BYTES) fail(`${p} is larger than ${FILE_MAX_BYTES / 1024} KB, the most \`file\` takes.`);
    bytes = buf.subarray(0, n);
  } finally {
    await fh.close().catch(() => {});
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); // drops a BOM
  } catch {
    fail(`${p} is not UTF-8 text.`);
  }
  if (!text.trim()) fail(`${p} is empty.`);
  if (text.length > FILE_MAX_CHARS) fail(`${p} has ${text.length} characters; \`file\` takes at most ${FILE_MAX_CHARS}.`);
  return { path: real, text };
}

/**
 * evaluate's arguments with `file` replaced by `expression`, or { error } (a message for Claude).
 * Arguments without `file` come back as they are.
 */
export async function expandEvalFile(args, dir) {
  if (!args || !('file' in args)) {
    if (!args || args.expression == null) return { error: 'Pass `expression` (the JavaScript to run) or `file`.' };
    return { args };
  }
  const { file, ...rest } = args;
  if ('expression' in rest) return { error: 'Pass either `expression` or `file`, not both.' };
  if (!dir) return { error: '`file` is not available here (no scripts directory). Pass the script as `expression`.' };
  try {
    const { text } = await readEvalFile(file, dir);
    return { args: { ...rest, expression: text } };
  } catch (e) {
    if (e instanceof EvalFileError) return { error: e.message };
    throw e;
  }
}

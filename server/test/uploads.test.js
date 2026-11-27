import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync, realpathSync, statSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readUploads, ensureUploadsDir, uploadsDir, UploadError, UPLOAD_MAX_BYTES, mimeType, badName } from '../src/uploads.js';

// A private config directory with its uploads directory, a secret next to it, and a directory elsewhere.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'cct-up-')));
chmodSync(base, 0o700);
const config = join(base, 'config');
const dir = uploadsDir(config);
const outside = join(base, 'elsewhere');
ensureUploadsDir(dir);
mkdirSync(outside, { recursive: true });
const put = (p, data) => { writeFileSync(p, data); return p; };
put(join(config, 'config.json'), 'secret');
put(join(outside, 'x.pdf'), 'outside');

test.after(() => rmSync(base, { recursive: true, force: true }));

async function rejects(names, re, d = dir, opts) {
  await assert.rejects(readUploads(names, d, opts), (e) => {
    assert.ok(e instanceof UploadError, e.stack);
    assert.match(e.message, re);
    return true;
  });
}

test('uploads: the directory is private and made by the service', () => {
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('uploads: reads files by name, in order, with a MIME type by extension', async () => {
  put(join(dir, 'report.pdf'), Buffer.from('%PDF-1.4 fake'));
  put(join(dir, 'photo.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]));
  put(join(dir, '数据 2026.csv'), 'a,b\n1,2\n');
  put(join(dir, 'empty.bin'), '');
  const r = await readUploads(['photo.JPG', 'report.pdf', '数据 2026.csv', 'empty.bin'], dir);
  assert.deepEqual(r.map((f) => [f.name, f.type, f.bytes.length]), [
    ['photo.JPG', 'image/jpeg', 5], ['report.pdf', 'application/pdf', 13], ['数据 2026.csv', 'text/csv', 8], ['empty.bin', 'application/octet-stream', 0],
  ]);
  assert.equal(r[2].bytes.toString(), 'a,b\n1,2\n');
  assert.equal(mimeType('a.tar.gz'), 'application/gzip');
  assert.equal(mimeType('noext'), 'application/octet-stream');
});

test('uploads: names only — no paths, hidden files, control characters, duplicates', async () => {
  await rejects(['../config/config.json'], /is a path/);
  await rejects([join(outside, 'x.pdf')], /is a path/);
  await rejects(['a\\b.pdf'], /is a path/);
  await rejects(['.secret'], /starts with "\."/);
  await rejects(['..'], /starts with "\."/);
  await rejects(['a\u0000b'], /control character/);
  await rejects(['a\nb.txt'], /control character/);
  await rejects(['a\u0085b'], /control character/);
  await rejects(['bad\ud800.txt'], /not valid text/);
  await rejects([''], /is empty/);
  await rejects(['x'.repeat(256)], /too long/);
  await rejects(['report.pdf', 'report.pdf'], /twice/);
  await rejects([], /at least one/);
  await rejects(Array.from({ length: 11 }, (_, i) => `f${i}`), /At most 10/);
  assert.equal(badName('ok name (1).pdf'), null);
});

test('uploads: links, hard links, other kinds of files and missing files are refused', async () => {
  symlinkSync(join(config, 'config.json'), join(dir, 'link.json'));
  await rejects(['link.json'], /is a link/);
  symlinkSync(join(dir, 'report.pdf'), join(dir, 'alias.pdf'));
  await rejects(['alias.pdf'], /is a link/, dir);
  // A hard link to a file outside (made without reading it): it would bypass "copy it in".
  linkSync(join(outside, 'x.pdf'), join(dir, 'hard.pdf'));
  await rejects(['hard.pdf'], /other hard links/);
  mkdirSync(join(dir, 'sub'));
  await rejects(['sub'], /not a regular file/);
  execFileSync('mkfifo', [join(dir, 'fifo')]);
  await rejects(['fifo'], /not a regular file/);
  await rejects(['nope.pdf'], /There is no file "nope.pdf"/);
  // Nothing is returned when one of several fails: all are checked first.
  await rejects(['report.pdf', 'nope.pdf'], /no file "nope.pdf"/);
});

test('uploads: the size limit is for all files together, read from the opened file', async () => {
  const d = join(base, 'c2', 'uploads');
  ensureUploadsDir(d);
  put(join(d, 'a.bin'), Buffer.alloc(600));
  put(join(d, 'b.bin'), Buffer.alloc(500));
  assert.equal((await readUploads(['a.bin', 'b.bin'], d, { maxBytes: 1100 })).length, 2);
  await rejects(['a.bin', 'b.bin'], /larger than/, d, { maxBytes: 1099 });
  await rejects(['a.bin'], /larger than/, d, { maxBytes: 599 });
  assert.equal(UPLOAD_MAX_BYTES, 20 * 1024 * 1024);
});

test('uploads: off when the directory, or one above it, is not private', async () => {
  // The uploads directory itself: a link, or open to others.
  const c3 = join(base, 'c3');
  mkdirSync(c3, { mode: 0o700 });
  symlinkSync(outside, join(c3, 'uploads'));
  await rejects(['x.pdf'], /not a private directory/, join(c3, 'uploads'));
  const c4 = join(base, 'c4', 'uploads');
  ensureUploadsDir(c4);
  put(join(c4, 'f.txt'), 'f');
  chmodSync(c4, 0o755);
  await rejects(['f.txt'], /not a private directory/, c4);
  chmodSync(c4, 0o700);
  assert.equal((await readUploads(['f.txt'], c4)).length, 1);
  // A directory above it that others can write to (they could swap what is below).
  chmodSync(join(base, 'c4'), 0o777);
  await rejects(['f.txt'], /can be changed by another user/, c4);
  // A sticky one (like /tmp) is fine: others can't rename what isn't theirs.
  chmodSync(join(base, 'c4'), 0o1777);
  assert.equal((await readUploads(['f.txt'], c4)).length, 1);
  chmodSync(join(base, 'c4'), 0o700);
  await rejects(['f.txt'], /does not exist/, join(base, 'nowhere', 'uploads'));
});

test('uploads: a link above the directory is followed, and the real directories are checked', async () => {
  const real = join(base, 'realconf');
  mkdirSync(real, { mode: 0o700 });
  ensureUploadsDir(join(real, 'uploads'));
  put(join(real, 'uploads', 'g.txt'), 'g');
  symlinkSync(real, join(base, 'linkconf'));
  assert.equal((await readUploads(['g.txt'], join(base, 'linkconf', 'uploads')))[0].bytes.toString(), 'g');
  chmodSync(real, 0o777);
  await rejects(['g.txt'], /can be changed by another user/, join(base, 'linkconf', 'uploads'));
  chmodSync(real, 0o700);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync, realpathSync, statSync, chmodSync, readFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readUploads, ensureUploadsDir, uploadsDir, UploadError, UPLOAD_MAX_BYTES, mimeType, badName, parseUidMap, idView, ownerKind, uploadsDirStatus } from '../src/uploads.js';

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

// A systemd user service with ProtectSystem=/PrivateTmp= runs in a user namespace that maps only its
// own user, so root's directories (/, /home, /tmp) show the overflow owner (65534).

test('uploads: uid_map and the overflow id tell which owners this process can see', () => {
  assert.deepEqual(parseUidMap('         0          0 4294967295\n'), [{ inside: 0, count: 4294967295 }]);
  assert.equal(parseUidMap('0 0'), null);
  assert.equal(parseUidMap('a b c'), null);
  assert.equal(parseUidMap(''), null);
  // Outside any namespace, or without /proc: everything is mapped, as before.
  const full = idView({ uidMap: '0 0 4294967295\n', overflow: '65534\n' });
  assert.deepEqual(full, { partial: false, rootMapped: true, overflow: 65534 });
  assert.deepEqual(idView({ uidMap: null, overflow: '65534' }), { partial: false, rootMapped: true, overflow: null });
  assert.equal(ownerKind(65534, 1000, full), 'other');
  assert.equal(ownerKind(0, 1000, full), 'root');
  // The systemd sandbox: only this user (1000) is mapped.
  const sandbox = idView({ uidMap: '      1000       1000          1\n', overflow: '65534\n' });
  assert.deepEqual(sandbox, { partial: true, rootMapped: false, overflow: 65534 });
  assert.equal(ownerKind(65534, 1000, sandbox), 'unknown');
  assert.equal(ownerKind(1000, 1000, sandbox), 'me');
  assert.equal(ownerKind(999, 1000, sandbox), 'other');
  assert.equal(ownerKind(1001, 1000, sandbox), 'other');
  assert.equal(ownerKind(0, 1000, sandbox), 'other', 'uid 0 is not root where root is not mapped');
  // Range edges: "1000 1000 2" maps 1000 and 1001, not 1002.
  const two = idView({ uidMap: '1000 1000 2', overflow: '1002' });
  assert.equal(two.rootMapped, false);
  assert.equal(ownerKind(1002, 1000, two), 'unknown');
  // The overflow id mapped too (or equal to this user): ambiguous, so never this user's or root's.
  const clash = idView({ uidMap: '1000 1000 1', overflow: '1000' });
  assert.equal(ownerKind(1000, 1000, clash), 'unknown');
  const rootClash = idView({ uidMap: '0 100000 65536', overflow: '0' });
  assert.equal(ownerKind(0, 1000, rootClash), 'unknown');
  // Overflow unreadable: nothing counts as unknown (no exception), and root still has to be mapped.
  const noOverflow = idView({ uidMap: '1000 1000 1', overflow: null });
  assert.deepEqual(noOverflow, { partial: true, rootMapped: false, overflow: null });
  assert.equal(ownerKind(65534, 1000, noOverflow), 'other');
  assert.equal(ownerKind(0, 1000, noOverflow), 'other');
});

test('uploads: in a sandbox, unknown owners are trusted only above this user\'s home', async (t) => {
  // Simulate the sandbox without one: whatever owner / shows (root, or the overflow id when these
  // tests run in a namespace themselves) is "the overflow id" of a namespace that doesn't map root.
  const rootOwner = statSync('/').uid;
  if (rootOwner === process.getuid()) return t.skip('running as the owner of /');
  const view = { partial: true, rootMapped: false, overflow: rootOwner };
  const home = join(base, 'home');
  const up = join(home, '.config', 'cctether', 'uploads');
  mkdirSync(join(home, '.config', 'cctether'), { recursive: true, mode: 0o700 });
  ensureUploadsDir(up);
  put(join(up, 'h.txt'), 'h');
  // Inside the home: /, /tmp (above the home) are trusted.
  assert.equal((await readUploads(['h.txt'], up, { view, homeDir: home }))[0].bytes.toString(), 'h');
  // A link to the home in the password database is resolved first.
  symlinkSync(home, join(base, 'homelink'));
  assert.equal((await readUploads(['h.txt'], up, { view, homeDir: join(base, 'homelink') })).length, 1);
  // Not inside the home (another home; one whose name is a prefix of this one): not trusted.
  const other = join(base, 'otherhome');
  mkdirSync(other, { mode: 0o700 });
  await rejects(['h.txt'], /owner this service can't see/, up, { view, homeDir: other });
  mkdirSync(join(base, 'hom'), { mode: 0o700 });
  await rejects(['h.txt'], /owner this service can't see/, up, { view, homeDir: join(base, 'hom') });
  // No home (password database failed) or not an absolute path: not trusted.
  await rejects(['h.txt'], /owner this service can't see/, up, { view, homeDir: null });
  await rejects(['h.txt'], /owner this service can't see/, up, { view, homeDir: 'home' });
  // A home whose own owner is unknown (here /, "root's"): not trusted.
  await rejects(['h.txt'], /owner this service can't see/, up, { view, homeDir: '/' });
  // The permission bits still count above the home: a trusted owner, but writable by others.
  chmodSync(home, 0o777);
  await rejects(['h.txt'], /can be changed by another user/, up, { view, homeDir: home });
  chmodSync(home, 0o700);
  // The overflow id unreadable: no exception, and "root" (0) is not trusted where root isn't mapped.
  await rejects(['h.txt'], /can be changed by another user|not a directory of this user or root/, up, { view: { ...view, overflow: null }, homeDir: home });
});

test('uploads: in a real user namespace that maps only this user (like the systemd service)', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux only');
  const me = process.getuid();
  const home = join(base, 'nshome');
  const up = join(home, 'conf', 'uploads');
  mkdirSync(join(home, 'conf'), { recursive: true, mode: 0o700 });
  ensureUploadsDir(up);
  put(join(up, 'n.txt'), 'namespace');
  const script = `
    import { readUploads } from ${JSON.stringify(new URL('../src/uploads.js', import.meta.url).href)};
    import { readFileSync, statSync } from 'node:fs';
    const [up, home] = process.argv.slice(1);
    const out = { uidMap: readFileSync('/proc/self/uid_map', 'utf8').trim().split(/\\s+/).map(Number), rootUid: statSync('/').uid };
    for (const [k, h] of [['inHome', home], ['otherHome', '/nonexistent']]) {
      try { out[k] = (await readUploads(['n.txt'], up, { homeDir: h }))[0].bytes.toString(); }
      catch (e) { out[k] = 'error: ' + e.message; }
    }
    console.log(JSON.stringify(out));`;
  let r;
  try {
    r = execFileSync('unshare', ['--user', '--map-current-user', process.execPath, '--input-type=module', '-e', script, up, home], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // Only when this system won't make one (no unshare; AppArmor on Ubuntu 24.04 forbids it).
    if (e.code === 'ENOENT' || /Operation not permitted|Permission denied|unrecognized option/.test(String(e.stderr))) return t.skip(`can't make a user namespace here: ${String(e.stderr || e.code).trim()}`);
    throw e;
  }
  const out = JSON.parse(r);
  assert.deepEqual(out.uidMap, [me, me, 1], 'the same map as the systemd service');
  assert.equal(out.rootUid, Number(readFileSync('/proc/sys/kernel/overflowuid', 'utf8')), 'root shows as the overflow id');
  assert.equal(out.inHome, 'namespace');
  assert.match(out.otherHome, /owner this service can't see/);
});

test('uploads: on Linux, files are opened from the directory that was checked, even if the path changes', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux only (/proc/self/fd)');
  const conf = join(base, 'bound');
  const up = join(conf, 'uploads');
  mkdirSync(conf, { mode: 0o700 });
  ensureUploadsDir(up);
  put(join(up, 'b.txt'), 'checked');
  // Between the checks and the opens, the uploads directory is moved away and another put in its place.
  const got = await readUploads(['b.txt'], up, {
    afterCheck: () => {
      renameSync(up, join(conf, 'moved'));
      ensureUploadsDir(up);
      put(join(up, 'b.txt'), 'swapped');
    },
  });
  assert.equal(got[0].bytes.toString(), 'checked', 'opened by the path, it would be the swapped one');
});

test('uploads: a directory this user may enter but not read: by path as before, but not after a relaxed check', async (t) => {
  if (process.platform !== 'linux') return t.skip('Linux only (/proc/self/fd)');
  if (process.getuid() === 0) return t.skip('root reads any directory');
  const rootOwner = statSync('/').uid;
  const home = join(base, 'h300');
  const up = join(home, 'uploads');
  mkdirSync(home, { mode: 0o700 });
  ensureUploadsDir(up);
  put(join(up, 'x.txt'), 'x');
  chmodSync(up, 0o300); // can't be opened for reading, so it can't be bound
  try {
    // Nothing relaxed: opened by the checked path, as in 0.8.0. (Not when these tests themselves
    // run in a namespace that hides root: then the real check is the relaxed one.)
    const real = idView({ uidMap: readFileSync('/proc/self/uid_map', 'utf8'), overflow: readFileSync('/proc/sys/kernel/overflowuid', 'utf8') });
    if (!real.partial) assert.equal((await readUploads(['x.txt'], up))[0].bytes.toString(), 'x');
    // Passed only because unknown owners above the home were trusted: the binding is required.
    await rejects(['x.txt'], /can't open the files through the directory it checked/, up, { view: { partial: true, rootMapped: false, overflow: rootOwner }, homeDir: home });
  } finally {
    chmodSync(up, 0o700);
  }
});

test('uploads: a group-writable directory above is refused, and the error says which one', async (t) => {
  if (process.getuid() === 0) return t.skip('root');
  // Like ~/.config on Debian and Ubuntu (umask 002).
  const home = join(base, 'gwhome');
  const up = join(home, '.config', 'cctether', 'uploads');
  mkdirSync(join(home, '.config', 'cctether'), { recursive: true, mode: 0o700 });
  ensureUploadsDir(up);
  put(join(up, 'g.txt'), 'g');
  const cfg = join(home, '.config');
  try {
    chmodSync(cfg, 0o771);
    await rejects(['g.txt'], /^The directory 2 levels above the uploads directory can be changed by another user.*chmod go-w/, up, { homeDir: home });
    chmodSync(cfg, 0o700);
    chmodSync(join(cfg, 'cctether'), 0o770);
    await rejects(['g.txt'], /^The directory 1 level above the uploads directory can be changed/, up, { homeDir: home });
    chmodSync(join(cfg, 'cctether'), 0o700);
    assert.equal((await readUploads(['g.txt'], up, { homeDir: home }))[0].bytes.toString(), 'g');
  } finally {
    chmodSync(cfg, 0o700);
    chmodSync(join(cfg, 'cctether'), 0o700);
  }
});

test('uploads: uploadsDirStatus says why, with the directory, for setup and check', async (t) => {
  if (process.getuid() === 0) return t.skip('root');
  const conf = join(base, 'st', 'conf');
  const up = join(conf, 'uploads');
  mkdirSync(conf, { recursive: true, mode: 0o700 });
  ensureUploadsDir(up);
  assert.deepEqual(await uploadsDirStatus(up), { ok: true, dir: up });
  const missing = await uploadsDirStatus(join(conf, 'nope'));
  assert.equal(missing.code, 'missing');
  assert.match(missing.message, /does not exist/);
  // A directory above, writable by its group: which one, with its device and inode.
  chmodSync(conf, 0o770);
  const w = await uploadsDirStatus(up);
  const st = statSync(conf, { bigint: true });
  assert.deepEqual({ ...w, message: undefined }, { ok: false, code: 'above_writable', level: 1, path: conf, dev: String(st.dev), ino: String(st.ino), message: undefined });
  assert.match(w.message, /^The directory 1 level above the uploads directory can be changed/);
  chmodSync(conf, 0o700);
  // The uploads directory itself open to others.
  chmodSync(up, 0o755);
  assert.equal((await uploadsDirStatus(up)).code, 'not_private');
  chmodSync(up, 0o700);
  // Its owner can't put files in or open them: not usable (reading its list isn't needed).
  chmodSync(up, 0o600);
  assert.equal((await uploadsDirStatus(up)).code, 'not_usable');
  chmodSync(up, 0o300);
  assert.equal((await uploadsDirStatus(up)).ok, true);
  chmodSync(up, 0o700);
  // Can't be looked at (no permission on the folder above): not "missing".
  chmodSync(conf, 0o000);
  try {
    const c = await uploadsDirStatus(up);
    assert.equal(c.code, 'cant_check');
    assert.match(c.message, /EACCES/);
  } finally {
    chmodSync(conf, 0o700);
  }
  // In a sandbox: an owner it can't see, not above the home; root not mapped (owner not trusted).
  const rootOwner = statSync('/').uid;
  const u = await uploadsDirStatus(up, { view: { partial: true, rootMapped: false, overflow: rootOwner }, homeDir: '/nonexistent' });
  assert.equal(u.code, 'above_unknown');
  assert.equal(u.path, '/');
  const o = await uploadsDirStatus(up, { view: { partial: true, rootMapped: false, overflow: null } });
  assert.equal(o.code, 'above_owner');
  assert.equal(o.path, '/');
});

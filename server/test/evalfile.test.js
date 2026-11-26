import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, statSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readEvalFile, expandEvalFile, ensureScriptsDir, scriptsDir, EvalFileError, FILE_MAX_BYTES, FILE_MAX_CHARS,
} from '../src/evalfile.js';

// A config directory with its scripts directory, a secret next to it, and a directory elsewhere.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'cct-ef-')));
const config = join(base, 'config');
const dir = scriptsDir(config);
const outside = join(base, 'elsewhere');
ensureScriptsDir(dir);
mkdirSync(join(dir, 'sub'), { recursive: true });
mkdirSync(join(dir, '.hidden'), { recursive: true });
mkdirSync(outside, { recursive: true });
const put = (p, data) => { writeFileSync(p, data); return p; };
put(join(config, 'config.js'), 'secret');
put(join(outside, 'x.js'), '1');

test.after(() => rmSync(base, { recursive: true, force: true }));

async function rejects(file, re) {
  await assert.rejects(readEvalFile(file, dir), (e) => {
    assert.ok(e instanceof EvalFileError, e.stack);
    assert.match(e.message, re);
    return true;
  });
}

test('evaluate file: the scripts directory is private', () => {
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('evaluate file: reads a .js file in the scripts directory (by name, by path, BOM, UTF-8)', async () => {
  put(join(dir, 'a.js'), 'const x = 1;\nx + 1\n');
  const r = await readEvalFile('a.js', dir);
  assert.equal(r.text, 'const x = 1;\nx + 1\n');
  assert.equal(r.path, join(dir, 'a.js'));
  assert.equal((await readEvalFile(join(dir, 'a.js'), dir)).text, r.text, 'by absolute path');
  put(join(dir, 'sub', 'b.js'), '2');
  assert.equal((await readEvalFile('sub/b.js', dir)).text, '2', 'in a subdirectory');
  put(join(dir, 'bom.js'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('1 + 1')]));
  assert.equal((await readEvalFile('bom.js', dir)).text, '1 + 1', 'the BOM is dropped');
  put(join(dir, 'cjk.js'), '"你好"');
  assert.equal((await readEvalFile('cjk.js', dir)).text, '"你好"');
  symlinkSync(join(dir, 'a.js'), join(dir, 'alias.js'));
  assert.equal((await readEvalFile('alias.js', dir)).text, r.text, 'a link to a script in the directory');
});

test('evaluate file: refuses anything outside the scripts directory', async () => {
  await rejects(join(outside, 'x.js'), /not in cctether's scripts directory/);
  await rejects('../config.js', /not in cctether's scripts directory/);
  await rejects('../../elsewhere/x.js', /not in cctether's scripts directory/);
  put(join(dir, '.hidden', 'k.js'), '1');
  await rejects('.hidden/k.js', /hidden/);
  put(join(dir, '.dot.js'), '1');
  await rejects('.dot.js', /hidden/);
  put(join(dir, 'notes.txt'), '1');
  await rejects('notes.txt', /not a \.js file/);
  await rejects('a.mjs', /not a \.js file/);
  await rejects('missing.js', /There is no file .*Write the script into/);
  await rejects('a\0.js', /NUL/);
  await rejects('', /empty/);
  // Links whose names look fine but lead out, into a hidden place, or to a file that isn't .js.
  symlinkSync(join(config, 'config.js'), join(dir, 'link-secret.js'));
  await rejects('link-secret.js', /not in cctether's scripts directory/);
  symlinkSync(join(dir, '.hidden', 'k.js'), join(dir, 'link-hidden.js'));
  await rejects('link-hidden.js', /hidden/);
  symlinkSync(join(dir, 'notes.txt'), join(dir, 'link-txt.js'));
  await rejects('link-txt.js', /links to a file that is not a \.js file/);
  symlinkSync(outside, join(dir, 'linkdir'));
  await rejects('linkdir/x.js', /not in cctether's scripts directory/);
  mkdirSync(join(dir, 'dir.js'));
  await rejects('dir.js', /not a regular file/);
  execFileSync('mkfifo', [join(dir, 'fifo.js')]);
  await rejects('fifo.js', /not a regular file/);
  await assert.rejects(readEvalFile('a.js', join(base, 'nope')), /does not exist/);
});

test('evaluate file: limits on size, characters, encoding and emptiness; no contents in messages', async () => {
  put(join(dir, 'big.js'), 'x'.repeat(FILE_MAX_BYTES + 1));
  await rejects('big.js', /at most 200 KB/);
  // 200 KB of ASCII is 204 800 characters: over the character limit (that of `expression`).
  put(join(dir, 'max.js'), 'x'.repeat(FILE_MAX_BYTES));
  await rejects('max.js', new RegExp(`at most ${FILE_MAX_CHARS}`));
  put(join(dir, 'ok.js'), 'x'.repeat(FILE_MAX_CHARS));
  assert.equal((await readEvalFile('ok.js', dir)).text.length, FILE_MAX_CHARS);
  put(join(dir, 'latin1.js'), Buffer.concat([Buffer.from('"TOKEN-abc'), Buffer.from([0xe9, 0x22])]));
  await rejects('latin1.js', /not UTF-8/);
  await assert.rejects(readEvalFile('latin1.js', dir), (e) => !e.message.includes('TOKEN'));
  put(join(dir, 'blank.js'), ' \n\t');
  await rejects('blank.js', /is empty/);
});

test('evaluate file: expandEvalFile swaps file for expression', async () => {
  put(join(dir, 'go.js'), 'document.title');
  assert.deepEqual(await expandEvalFile({ file: 'go.js', world: 'isolated', tab: 3 }, dir),
    { args: { expression: 'document.title', world: 'isolated', tab: 3 } });
  assert.match((await expandEvalFile({ file: 'go.js', expression: '1' }, dir)).error, /not both/);
  assert.match((await expandEvalFile({ world: 'page' }, dir)).error, /Pass `expression`/);
  assert.match((await expandEvalFile({ file: '.dot.js' }, dir)).error, /hidden/);
  assert.match((await expandEvalFile({ file: 'go.js' }, null)).error, /not available/);
  const plain = { expression: '1' };
  assert.equal((await expandEvalFile(plain, dir)).args, plain);
});

test('evaluate file: a scripts directory that is a link, or open to others, turns file off', async () => {
  const proj = join(base, 'project');
  mkdirSync(proj, { recursive: true, mode: 0o755 });
  put(join(proj, 'app.js'), 'secret project code');
  const cfg2 = join(base, 'config2');
  mkdirSync(cfg2, { recursive: true });
  symlinkSync(proj, scriptsDir(cfg2));
  ensureScriptsDir(scriptsDir(cfg2));
  assert.equal(statSync(proj).mode & 0o777, 0o755, 'the link target keeps its permissions');
  await assert.rejects(readEvalFile('app.js', scriptsDir(cfg2)), /not a private directory of this user \(it is a link/);
  // A scripts directory others can use is not made private at startup (what they put there
  // earlier would then look trusted): it stays as it is, and file is off.
  const cfg3 = join(base, 'config3');
  const open = scriptsDir(cfg3);
  mkdirSync(open, { recursive: true, mode: 0o777 });
  chmodSync(open, 0o777);
  put(join(open, 'x.js'), '1');
  ensureScriptsDir(open);
  assert.equal(statSync(open).mode & 0o777, 0o777);
  // A missing one is created private (also when its parent is missing).
  const fresh = scriptsDir(join(base, 'config4', 'nested'));
  ensureScriptsDir(fresh);
  assert.equal(statSync(fresh).mode & 0o777, 0o700);
  await assert.rejects(readEvalFile('x.js', open), /not a private directory/);
});

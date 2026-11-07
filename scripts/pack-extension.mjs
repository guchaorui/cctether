#!/usr/bin/env node
// Pack the extension into dist/cctether-extension-<version>.zip (SPEC §8.3).
//
//   node scripts/pack-extension.mjs           # zip with a cctether-extension/ folder inside
//   node scripts/pack-extension.mjs --flat    # for the Chrome Web Store: files at the top level, and
//                                             # no "key" in manifest.json (the store assigns its own ID)
//   node scripts/pack-extension.mjs --check   # only check that the versions match
//
// No dependencies. The zip is reproducible: the files are the ones git tracks in extension/ (sorted),
// stored without compression (so the bytes don't depend on the zlib version), and dated with
// SOURCE_DATE_EPOCH, else the last commit's time. Anyone can rebuild it from the same commit and
// compare the SHA-256 printed at the end (.gitattributes keeps line endings LF on every system).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const args = new Set(process.argv.slice(2));

const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'server', 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: extension/manifest.json is ${manifest.version}, server/package.json is ${pkg.version}. They must be the same.`);
  process.exit(1);
}
const version = pkg.version;
if (args.has('--check')) {
  console.log(`Versions match: ${version}`);
  process.exit(0);
}

function epoch() {
  if (process.env.SOURCE_DATE_EPOCH) return Number(process.env.SOURCE_DATE_EPOCH);
  try {
    return Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8' }).trim());
  } catch {
    return Date.UTC(2026, 0, 1) / 1000;
  }
}

/** The files git tracks in extension/ (falls back to the folder's contents outside a git checkout). */
function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', 'extension'], { cwd: ROOT, encoding: 'utf8' });
    const files = out.split('\0').filter(Boolean).map((f) => join(ROOT, f));
    if (files.length) return files;
  } catch {}
  return listFiles(EXT);
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue; // .DS_Store and friends
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

const when = new Date(epoch() * 1000);
const dosTime = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
const dosDate = ((when.getUTCFullYear() - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
const flat = args.has('--flat');
const prefix = flat ? '' : 'cctether-extension/';

const files = trackedFiles()
  .map((p) => ({ path: p, name: prefix + relative(EXT, p).split(sep).join('/') }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const local = [];
const central = [];
let offset = 0;
for (const f of files) {
  let data = readFileSync(f.path);
  if (flat && f.name === 'manifest.json') {
    const m = JSON.parse(data.toString('utf8'));
    delete m.key;
    data = Buffer.from(JSON.stringify(m, null, 2) + '\n');
  }
  const name = Buffer.from(f.name, 'utf8');
  const crc = crc32(data);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4); // version needed: 2.0
  h.writeUInt16LE(0x0800, 6); // UTF-8 names
  h.writeUInt16LE(0, 8); // stored
  h.writeUInt16LE(dosTime, 10);
  h.writeUInt16LE(dosDate, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(data.length, 18);
  h.writeUInt32LE(data.length, 22);
  h.writeUInt16LE(name.length, 26);
  h.writeUInt16LE(0, 28);
  local.push(h, name, data);

  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0);
  c.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, 2.0
  c.writeUInt16LE(20, 6);
  c.writeUInt16LE(0x0800, 8);
  c.writeUInt16LE(0, 10);
  c.writeUInt16LE(dosTime, 12);
  c.writeUInt16LE(dosDate, 14);
  c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(data.length, 20);
  c.writeUInt32LE(data.length, 24);
  c.writeUInt16LE(name.length, 28);
  c.writeUInt16LE(0, 30); // extra
  c.writeUInt16LE(0, 32); // comment
  c.writeUInt16LE(0, 34); // disk
  c.writeUInt16LE(0, 36); // internal attributes
  c.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
  c.writeUInt32LE(offset, 42);
  central.push(c, name);

  offset += h.length + name.length + data.length;
}
const centralSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

const zip = Buffer.concat([...local, ...central, end]);
const outDir = join(ROOT, 'dist');
mkdirSync(outDir, { recursive: true });
const outName = `cctether-extension-${version}${flat ? '-store' : ''}.zip`;
writeFileSync(join(outDir, outName), zip);
const sha = createHash('sha256').update(zip).digest('hex');
console.log(`dist/${outName}  ${files.length} files, ${(zip.length / 1024).toFixed(0)} KB`);
console.log(`sha256 ${sha}`);
console.log(`dated ${when.toISOString()} (${process.env.SOURCE_DATE_EPOCH ? 'SOURCE_DATE_EPOCH' : 'last commit'})`);

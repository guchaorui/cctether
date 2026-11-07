#!/usr/bin/env node
// Render the popup, the settings page and the toolbar icons in every state, language and colour
// scheme, for visual review.
//
//   node scripts/screenshots.mjs              # everything
//   node scripts/screenshots.mjs popup-conn   # only shots whose name contains "popup-conn"
//
// Output: screenshots/ (gitignored)
//   popup-<state>-<lang>-<theme>.png, options-<state>-<lang>-<theme>.png
//   sheet-popup-<state>.png, sheet-options-<state>.png   the four variants side by side
//   icons.png                                            toolbar icon contact sheet
//
// The real service worker is replaced (in a temporary copy of the extension) by a stub that answers
// UI messages and does nothing else; fake Status / Settings / Pairing / activity are written into
// chrome.storage through the stub's CDP session.

import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome } from '../test/e2e/lib/chrome.js';
import { openTab, sleep } from './lib/page.mjs';
import { STRINGS } from '../extension/shared/strings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'screenshots');
const filter = process.argv[2] ?? '';

// ---------------------------------------------------------------------------------------------
// Language pack sanity check

{
  const en = Object.keys(STRINGS.en), zh = Object.keys(STRINGS.zh);
  const missing = [...en.filter((k) => !zh.includes(k)).map((k) => `zh lacks ${k}`), ...zh.filter((k) => !en.includes(k)).map((k) => `en lacks ${k}`)];
  if (missing.length) { console.error('Language packs differ:\n  ' + missing.join('\n  ')); process.exit(1); }
}

// ---------------------------------------------------------------------------------------------
// Fake data

const NOW = Date.now();
const SERVER = 'browser.example.com';
const PAIRING = {
  url: `wss://${SERVER}/cctether`,
  key: 'not-a-real-key-not-a-real-key-not-a-real-k',
  fingerprint: '3f9a1c7e',
  pairedAt: NOW - 3 * 86400e3 - 4 * 3600e3,
};
const GH = { id: 0, title: 'Pull requests · guchaorui/cctether', host: 'github.com' };
const VITE = { id: 0, title: 'My extension – options', host: 'localhost:5173' };
const DOCS = { id: 0, title: 'chrome.tabGroups | API | Chrome for Developers', host: 'developer.chrome.com' };
const ACTIVITY = [
  { tool: 'screenshot', tab: GH, ok: true, ago: 8 },
  { tool: 'click', tab: GH, ok: true, ago: 21 },
  { tool: 'type', tab: GH, ok: false, error: 'element_not_found', ago: 40 },
  { tool: 'read_page', tab: GH, ok: true, ago: 64 },
  { tool: 'navigate', tab: GH, ok: true, ago: 95 },
  { tool: 'console_messages', tab: VITE, ok: true, ago: 260 },
  { tool: 'reload_extension', tab: null, ok: true, ago: 300 },
  { tool: 'network_requests', tab: DOCS, ok: true, ago: 610 },
  { tool: 'list_tabs', tab: null, ok: true, ago: 700 },
].map(({ ago, ...e }) => ({ ...e, t: NOW - ago * 1000 }));

const connected = { conn: 'connected', server: SERVER, since: NOW - 3600e3, error: null, retryAt: null, serverVersion: '0.1.0', sharedTabs: 2, attachedTabs: 1 };
const disc = (code, retryIn = 12000, detail) => ({
  ...connected, conn: 'disconnected', attachedTabs: 0,
  error: { code, ...(detail ? { detail } : {}) }, retryAt: null, retryIn,
});
const settings = (over = {}) => ({ lang: 'auto', paused: false, pausedReason: null, ...over });

/** popup scenarios: name → { status, settings, pairing, activity, tab: 'gh'|'restricted', tabInfo } */
const POPUP = {
  unpaired: { status: { conn: 'unpaired', server: null, sharedTabs: 0, attachedTabs: 0 }, pairing: null, activity: [] },
  connecting: { status: { ...connected, conn: 'connecting', attachedTabs: 0 }, activity: ACTIVITY },
  connected: { status: connected, activity: ACTIVITY },
  'connected-shared': { status: connected, activity: ACTIVITY, tabInfo: { ok: true, shared: true, restricted: false } },
  'connected-restricted': { status: { ...connected, attachedTabs: 0 }, activity: ACTIVITY.slice(0, 3), tab: 'restricted', tabInfo: { ok: true, shared: false, restricted: true } },
  'connected-empty': { status: { ...connected, sharedTabs: 0, attachedTabs: 0 }, activity: [] },
  'paused-user': { status: connected, settings: { paused: true, pausedReason: 'user' }, activity: ACTIVITY },
  'paused-debugger': { status: { ...connected, attachedTabs: 0 }, settings: { paused: true, pausedReason: 'debugger_canceled' }, activity: ACTIVITY },
  'disconnected-offline': { status: disc('offline', null), activity: ACTIVITY },
  'disconnected-unreachable': { status: disc('unreachable'), activity: ACTIVITY },
  'disconnected-rate_limited': { status: disc('rate_limited', 4 * 60e3 + 10e3), activity: ACTIVITY.slice(0, 4) },
  server_auth_failed: { status: disc('server_auth_failed', 30000), activity: ACTIVITY },
  auth_rejected: { status: disc('auth_rejected', 30000), activity: ACTIVITY },
  origin_rejected: { status: disc('origin_rejected', 30000), activity: ACTIVITY.slice(0, 3) },
  update_extension: { status: disc('update_extension', null), activity: ACTIVITY },
  update_server: { status: disc('update_server', null), activity: ACTIVITY.slice(0, 3) },
  protocol_error: { status: disc('protocol_error', 4000, 'decrypt failed at seq 41'), activity: ACTIVITY.slice(0, 3) },
  replaced: { status: { ...connected, conn: 'replaced', attachedTabs: 0 }, activity: ACTIVITY },
};

/** settings-page scenarios */
const OPTIONS = {
  unpaired: { status: POPUP.unpaired.status, pairing: null },
  connected: { status: connected },
  'invalid-code': { status: POPUP.unpaired.status, pairing: null, type: 'cctether1:eyJ1Ijoid3NzOi8vYnJvd3Nlci5leGFtcGxlLmNvbS9jY3RldGhlciJ9' },
  'insecure-code': { status: POPUP.unpaired.status, pairing: null, type: codeFor('ws://203.0.113.7:27182/cctether') },
  'valid-code': { status: POPUP.unpaired.status, pairing: null, type: codeFor(`wss://${SERVER}/cctether`) },
  'change-server': { status: connected, click: '.details-actions .btn-secondary' },
  'server_auth_failed': { status: disc('server_auth_failed', 30000) },
  paused: { status: connected, settings: { paused: true, pausedReason: 'debugger_canceled' } },
  'unpair-dialog': { status: connected, click: '.details-actions .btn-danger' },
};

function codeFor(url) {
  const key = Buffer.alloc(32, 7).toString('base64url');
  return 'cctether1:' + Buffer.from(JSON.stringify({ u: url, k: key })).toString('base64url');
}

// ---------------------------------------------------------------------------------------------
// Extension copy with a stub service worker

const STUB_SW = `
import { updateActionIcon } from './badge.js';
self.updateActionIcon = updateActionIcon;
self.__fake = { tabInfo: { ok: true, shared: false, restricted: false } };
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  switch (msg?.type) {
    case 'tabInfo': reply(self.__fake.tabInfo); break;
    case 'pair': reply({ ok: true, fingerprint: '3f9a1c7e', server: 'browser.example.com' }); break;
    default: reply({ ok: true });
  }
  return false;
});
`;

async function prepareExtension() {
  const dir = await mkdtemp(join(tmpdir(), 'cctether-shots-'));
  const ext = join(dir, 'extension');
  await cp(join(ROOT, 'extension'), ext, { recursive: true });
  await writeFile(join(ext, 'background', 'main.js'), STUB_SW);
  return { dir, ext };
}

// ---------------------------------------------------------------------------------------------

const VARIANTS = [['zh', 'light'], ['zh', 'dark'], ['en', 'light'], ['en', 'dark']];
const want = (name) => !filter || name.includes(filter);

async function main() {
  await mkdir(OUT, { recursive: true });
  const { dir, ext } = await prepareExtension();
  const chrome = await launchChrome({ extensions: [ext] });
  const failures = [];
  try {
    const id = chrome.extensionIdsByPath[ext];
    const sw = await chrome.extensionWorker(id);
    const base = `chrome-extension://${id}`;

    const ghTab = await fakeSiteTab(chrome, 'https://github.com/guchaorui/cctether/pulls', 'Pull requests · guchaorui/cctether');
    const restrictedTab = await openTab(chrome, 'chrome://version/');
    const tabIds = {
      gh: await sw.evaluate(`chrome.tabs.query({ url: 'https://github.com/*' }).then((t) => t[0].id)`),
      restricted: await sw.evaluate(`chrome.tabs.query({}).then((t) => t.find((x) => x.url.startsWith('chrome://version')).id)`),
    };
    void ghTab; void restrictedTab;

    const setState = async ({ status: raw, settings: st = {}, pairing = PAIRING, activity = [], tabInfo }, lang) => {
      // retryAt is relative to the moment of the shot, so the countdown shows a real number.
      const { retryIn, ...status } = raw;
      if (retryIn) status.retryAt = Date.now() + retryIn;
      const fixedTabs = activity.map((e) => (e.tab ? { ...e, tab: { ...e.tab, id: tabIds.gh } } : e));
      await sw.evaluate(`(async () => {
        await chrome.storage.local.clear();
        await chrome.storage.session.clear();
        await chrome.storage.local.set(${JSON.stringify({ settings: settings({ ...st, lang }), ...(pairing ? { pairing } : {}) })});
        await chrome.storage.session.set(${JSON.stringify({ status, activity: fixedTabs })});
        self.__fake.tabInfo = ${JSON.stringify(tabInfo ?? { ok: true, shared: false, restricted: false })};
      })()`);
    };

    // ---- popup
    const popup = await openTab(chrome);
    for (const [name, sc] of Object.entries(POPUP)) {
      const shots = [];
      for (const [lang, theme] of VARIANTS) {
        const file = `popup-${name}-${lang}-${theme}.png`;
        if (!want(file)) continue;
        await setState({ ...sc, status: { ...sc.status } }, lang);
        await popup.scheme(theme === 'dark');
        await popup.viewport(360, 600, 2);
        await popup.goto(`${base}/popup/popup.html?tabId=${tabIds[sc.tab ?? 'gh']}`);
        await sleep(250);
        const height = await popup.evaluate('Math.ceil(document.documentElement.getBoundingClientRect().height)');
        if (height > 600) failures.push(`${file}: popup is ${height}px tall (Chrome caps popups at 600px)`);
        await popup.viewport(360, height, 2);
        await sleep(60);
        await popup.screenshot(join(OUT, file));
        shots.push({ file, label: `${lang} · ${theme}`, h: height });
      }
      if (shots.length === 4) await sheet(chrome, `sheet-popup-${name}.png`, shots, 360);
    }

    // ---- settings page
    const opt = await openTab(chrome);
    for (const [name, sc] of Object.entries(OPTIONS)) {
      for (const width of [1000, 400]) {
        if (width === 400 && !['unpaired', 'connected', 'invalid-code'].includes(name)) continue;
        const shots = [];
        for (const [lang, theme] of VARIANTS) {
          const file = `options-${name}${width === 400 ? '-narrow' : ''}-${lang}-${theme}.png`;
          if (!want(file)) continue;
          await setState({ ...sc, activity: [] }, lang);
          await opt.scheme(theme === 'dark');
          await opt.viewport(width, 900, width === 400 ? 2 : 1);
          await opt.goto(`${base}/options/options.html`);
          await sleep(200);
          if (sc.type) {
            await opt.evaluate(`(() => { const c = document.getElementById('code'); c.value = ${JSON.stringify(sc.type)}; c.dispatchEvent(new Event('input')); c.blur(); })()`);
          } else {
            await opt.evaluate('document.activeElement?.blur()');
          }
          if (sc.click) await opt.evaluate(`document.querySelector(${JSON.stringify(sc.click)}).click(); document.activeElement?.blur()`);
          await sleep(150);
          const height = sc.click?.includes('danger')
            ? 900
            : await opt.evaluate('Math.ceil(document.documentElement.scrollHeight)');
          await opt.viewport(width, height, width === 400 ? 2 : 1);
          await sleep(60);
          await opt.screenshot(join(OUT, file));
          shots.push({ file, label: `${lang} · ${theme}`, h: height });
        }
        if (shots.length === 4) await sheet(chrome, `sheet-options-${name}${width === 400 ? '-narrow' : ''}.png`, shots, width === 400 ? 400 : 500);
      }
    }

    // ---- toolbar icons: check badge.js against the real chrome.action API, then the contact sheet
    if (want('icons')) {
      const checks = await sw.evaluate(`(async () => {
        const cases = {
          unpaired: [{ conn: 'unpaired' }, {}],
          connecting: [{ conn: 'connecting', server: 'browser.example.com' }, {}],
          connected: [{ conn: 'connected', server: 'browser.example.com' }, {}],
          disconnected: [{ conn: 'disconnected', error: { code: 'unreachable' } }, {}],
          replaced: [{ conn: 'replaced' }, {}],
          paused: [{ conn: 'connected', server: 'browser.example.com' }, { paused: true }],
        };
        const out = {};
        for (const [name, [status, settings]] of Object.entries(cases)) {
          for (const lang of ['en', 'zh']) {
            await self.updateActionIcon(status, { ...settings, lang });
            out[name + '/' + lang] = await chrome.action.getTitle({});
          }
          // setIcon rejects if an image is missing; check each path directly.
          await chrome.action.setIcon({ path: { 16: '/icons/state/' + name + '-16.png', 32: '/icons/state/' + name + '-32.png' } });
        }
        return out;
      })()`);
      console.log('toolbar titles:');
      for (const [k, v] of Object.entries(checks)) console.log(`  ${k.padEnd(18)} ${v}`);
      await iconSheet(chrome);
    }
  } finally {
    await chrome.close();
    await rm(dir, { recursive: true, force: true });
  }
  if (failures.length) console.warn('\nProblems:\n  ' + failures.join('\n  '));
  const files = (await readdir(OUT)).filter((f) => f.endsWith('.png'));
  console.log(`\n${files.length} screenshots in ${OUT}`);
}

/** A tab that shows a fake page at a real-looking URL (requests are answered locally). */
async function fakeSiteTab(chrome, url, title) {
  const page = await openTab(chrome);
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;padding:40px">${title}</body>`;
  await page.session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  chrome.cdp.onEvent((msg) => {
    if (msg.method !== 'Fetch.requestPaused' || msg.sessionId !== page.session.sessionId) return;
    page.session.send('Fetch.fulfillRequest', {
      requestId: msg.params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
      body: Buffer.from(html).toString('base64'),
    }).catch(() => {});
  });
  await page.goto(url);
  return page;
}

/** Put four screenshots side by side for quick comparison. */
async function sheet(chrome, name, shots, colWidth) {
  const items = shots.map((s) => `<figure><figcaption>${s.label}</figcaption><img src="${pathToFileURL(join(OUT, s.file))}" width="${colWidth}"></figure>`).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:16px;background:#8b9198;display:flex;gap:16px;align-items:flex-start;font:12px sans-serif;color:#fff}
    figure{margin:0}figcaption{margin-bottom:6px}img{display:block;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.25)}
  </style>${items}`;
  const file = join(OUT, `.${name}.html`);
  await writeFile(file, html);
  const page = await openTab(chrome);
  const w = shots.length * (colWidth + 16) + 16;
  await page.viewport(w, 400, 2);
  await page.goto(pathToFileURL(file).href);
  await sleep(150);
  const h = await page.evaluate('Math.ceil(document.documentElement.scrollHeight)');
  await page.viewport(w, h, 2);
  await sleep(60);
  await page.screenshot(join(OUT, name));
  await page.close();
  await rm(file);
}

/** Toolbar icon contact sheet: every state at 16 px (1×) and 32 px (2× / retina), light and dark toolbars. */
async function iconSheet(chrome) {
  const states = ['connected', 'connecting', 'disconnected', 'replaced', 'paused', 'unpaired'];
  const icons = join(ROOT, 'extension', 'icons');
  const src = (f) => pathToFileURL(join(icons, f)).href;
  const toolbars = [['Light toolbar', '#ffffff', '#1f1f1f'], ['Light (grey)', '#f1f3f4', '#1f1f1f'], ['Dark toolbar', '#3c3c3c', '#e3e3e3'], ['Dark (deep)', '#202124', '#e3e3e3']];
  const rows = states.map((s) => `<tr><th>${s}</th>${toolbars.map(([, bg]) => `
      <td style="background:${bg}"><img class="x1" src="${src(`state/${s}-16.png`)}" width="16" height="16"><img src="${src(`state/${s}-32.png`)}" width="16" height="16"></td>`).join('')}
      <td class="zoom"><img class="x1" src="${src(`state/${s}-16.png`)}" width="64" height="64"><img class="x1" src="${src(`state/${s}-32.png`)}" width="64" height="64"></td></tr>`).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:20px;font:12px -apple-system,Arial,sans-serif;background:#fff;color:#222}
    table{border-collapse:separate;border-spacing:6px}
    th{text-align:right;font-weight:600;padding-right:8px}
    thead th{text-align:center;font-weight:500;color:#666;padding:0 0 4px}
    td{padding:10px 14px;border-radius:8px}
    td img{display:inline-block;vertical-align:middle;margin:0 8px}
    img.x1{image-rendering:pixelated}
    td.zoom{background:repeating-conic-gradient(#e9e9e9 0 25%,#fff 0 50%) 0 0/16px 16px}
    .brand{display:flex;gap:24px;align-items:flex-end;margin:6px 0 18px 6px}
    .brand figure{margin:0;text-align:center;color:#666}
    p{color:#555;margin:0 0 6px 6px}
  </style>
  <div class="brand">${[16, 32, 48, 128].map((n) => `<figure><img src="${src(`icon-${n}.png`)}" width="${n}" height="${n}"><figcaption>icon-${n}</figcaption></figure>`).join('')}</div>
  <p>Each toolbar cell: the 16 px PNG on a 1× screen (left, pixel-doubled), the 32 px PNG on a 2× screen (right). Last column: 16 px and 32 px PNGs zoomed.</p>
  <table><thead><tr><th></th>${toolbars.map(([n]) => `<th>${n}</th>`).join('')}<th>zoom</th></tr></thead><tbody>${rows}</tbody></table>`;
  const file = join(OUT, '.icons.html');
  await writeFile(file, html);
  const page = await openTab(chrome);
  await page.viewport(860, 400, 2);
  await page.goto(pathToFileURL(file).href);
  await sleep(150);
  const h = await page.evaluate('Math.ceil(document.documentElement.scrollHeight)');
  await page.viewport(860, h, 2);
  await sleep(60);
  await page.screenshot(join(OUT, 'icons.png'));
  await page.close();
  await rm(file);
}

await main();

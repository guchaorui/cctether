// Security review (SPEC §6.3), browser side: headless Chrome for Testing with the cctether
// extension. Covers threat 4 (a malicious web page trying to reach the loopback gateway or
// escape the tab-group scope) and threat 5 (prompt-injected tool arguments: dangerous URLs).
// Attacks that are correctly blocked stay as regressions; a { todo: 'SECURITY: ...' } test
// demonstrates a real gap without turning the suite red.
//
// Run: node --test test/e2e/security.test.mjs   (headless Chrome for Testing)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchChrome } from './lib/chrome.js';
import { Gateway } from '../../server/src/gateway.js';
import { FailureLimiter } from '../../server/src/ratelimit.js';
import { DEFAULT_EXTENSION_IDS } from '../../server/src/config.js';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const EXT = join(ROOT, 'extension');
const EXT_ID = 'nfebjhhcnoilmfjacolkofphfekkjioh';

let browser;
let sw;
let gateway;
let gwPort;
let pageSession;
let webServer;

async function call(name, args = {}) {
  return sw.evaluate(`self.cctether.runTool(${JSON.stringify(name)}, ${JSON.stringify(args)})
    .then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code, message: e.message }))`);
}

before(async () => {
  // A real cctether gateway, bound to loopback like a deployed service.
  gateway = new Gateway({ key: Buffer.alloc(32, 7), extensionIds: DEFAULT_EXTENSION_IDS, version: '9.9.9' });
  gwPort = await gateway.listen(0);

  browser = await launchChrome({ extensions: [EXT], headless: true });
  sw = await browser.extensionWorker(EXT_ID);

  // A page with a normal web origin: the attacker's position. Served over http, not about:blank —
  // the extension's first-run settings page sometimes takes over a blank tab, and then the test
  // would be running as the extension itself.
  webServer = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>attacker</title>'); });
  await new Promise((r) => webServer.listen(0, '127.0.0.1', r));
  const { targetId } = await browser.cdp.send('Target.createTarget', { url: `http://127.0.0.1:${webServer.address().port}/` });
  pageSession = await browser.cdp.attach(targetId);
  for (let i = 0; i < 50 && !String(await pageSession.evaluate('location.origin')).startsWith('http://'); i++) await sleep(100);
});

after(async () => {
  await browser?.close();
  await gateway?.close();
  webServer?.close();
});

// --- Threat 4: a web page cannot impersonate the extension to the gateway ----------------------

test('a web page connecting to the loopback gateway is rejected by the Origin check', async () => {
  assert.match(String(await pageSession.evaluate('location.origin')), /^http:\/\/127\.0\.0\.1:/, 'the test page has a web origin');
  const res = await pageSession.evaluate(`new Promise((resolve) => {
    let got = null;
    const ws = new WebSocket('ws://127.0.0.1:${gwPort}/cctether');
    ws.onmessage = (e) => { try { got = JSON.parse(e.data); } catch {} };
    ws.onclose = (ev) => resolve({ code: ev.code, msg: got });
    ws.onerror = () => {};
    setTimeout(() => resolve({ code: 'timeout', msg: got }), 10000);
  })`);
  // The browser forces the real page Origin (a page cannot forge chrome-extension://...), so the
  // gateway refuses it before any challenge: no handshake, closed with 4403.
  assert.equal(res.code, 4403, `expected originRejected close; got ${JSON.stringify(res)}`);
  assert.deepEqual(res.msg, { t: 'error', code: 'origin_rejected' });
  assert.equal(gateway.browser, null, 'no browser was adopted');
});

// --- Threat 5: dangerous URLs in tool arguments -------------------------------------------------

test('open_tab refuses javascript: and chrome:// URLs', async () => {
  const js = await call('open_tab', { url: 'javascript:alert(1)' });
  assert.equal(js.ok, false);
  assert.equal(js.code, 'bad_args');

  const chrome = await call('open_tab', { url: 'chrome://settings' });
  assert.equal(chrome.ok, false);
  assert.equal(chrome.code, 'restricted_url');
});

test('navigate refuses javascript: and chrome:// URLs on a shared tab', async () => {
  // Need a shared tab to navigate; open one (about:blank is allowed).
  const opened = await call('open_tab', { url: 'about:blank' });
  assert.ok(opened.ok, JSON.stringify(opened));
  const tabId = opened.r.tab.id;

  const js = await call('navigate', { tab: tabId, url: 'javascript:alert(1)' });
  assert.equal(js.ok, false);
  assert.equal(js.code, 'bad_args');

  const chrome = await call('navigate', { tab: tabId, url: 'chrome://version' });
  assert.equal(chrome.ok, false);
  assert.equal(chrome.code, 'restricted_url');

  await call('close_tab', { tab: tabId });
});

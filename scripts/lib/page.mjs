// Small helpers on top of test/e2e/lib/chrome.js for rendering pages to PNG.

import { writeFile } from 'node:fs/promises';

/**
 * Open a new tab and return a session helper.
 * @param {object} chrome  result of launchChrome()
 */
export async function openTab(chrome, url = 'about:blank') {
  const { cdp } = chrome;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const s = await cdp.attach(targetId);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  const page = {
    targetId,
    session: s,
    evaluate: s.evaluate,
    async goto(u) {
      const loaded = cdp.waitForEvent('Page.loadEventFired', (_p, msg) => msg.sessionId === s.sessionId, 15000);
      await s.send('Page.navigate', { url: u });
      await loaded;
    },
    async viewport(width, height, deviceScaleFactor = 2) {
      await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
    },
    async scheme(dark) {
      await s.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
      });
    },
    async transparent() {
      await s.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    },
    async screenshot(path, clip) {
      const params = { format: 'png', captureBeyondViewport: false };
      if (clip) params.clip = { scale: 1, ...clip };
      const { data } = await s.send('Page.captureScreenshot', params);
      await writeFile(path, Buffer.from(data, 'base64'));
    },
    async close() {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    },
  };
  if (url !== 'about:blank') await page.goto(url);
  return page;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Launch Chrome for Testing with unpacked extensions and a CDP connection.

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CDP } from './cdp.js';

export async function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const base = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(base)) {
    const dirs = (await readdir(base)).filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      const p = join(base, d, 'chrome-linux64', 'chrome');
      if (existsSync(p)) return p;
    }
  }
  throw new Error('Chrome for Testing not found. Set CHROME_PATH.');
}

/**
 * @param {object} opts
 * @param {string[]} [opts.extensions] absolute paths of unpacked extensions
 * @param {boolean} [opts.headless=true]
 * @param {string[]} [opts.args]
 * @param {object} [opts.env]
 */
export async function launchChrome({ extensions = [], headless = true, args = [], env = {} } = {}) {
  const exe = await findChrome();
  const userDataDir = await mkdtemp(join(tmpdir(), 'cctether-chrome-'));
  const flags = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--password-store=basic',
    '--use-mock-keychain',
    ...(headless ? ['--headless'] : []),
    ...args,
    'about:blank',
  ];
  const proc = spawn(exe, flags, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; if (stderr.length > 100000) stderr = stderr.slice(-50000); });
  const cdp = CDP.fromPipe(proc.stdio[3], proc.stdio[4]);
  try {
    await cdp.send('Browser.getVersion');
  } catch (e) {
    throw new Error(`Chrome did not answer over the debugging pipe: ${e.message}\n${stderr}`);
  }
  const extensionIdsByPath = {};
  for (const path of extensions) {
    // Same code path as "Load unpacked" on chrome://extensions.
    const { id } = await cdp.send('Extensions.loadUnpacked', { path });
    extensionIdsByPath[path] = id;
  }

  return {
    cdp,
    proc,
    extensionIdsByPath,
    userDataDir,
    stderr: () => stderr,
    /** Wait for an extension service worker target and return its CDP session. */
    async extensionWorker(extensionId, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { targetInfos } = await cdp.send('Target.getTargets');
        const t = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`));
        if (t) {
          // A freshly started worker can briefly expose a context without extension bindings.
          const s = await cdp.attach(t.targetId);
          const ok = await s.evaluate('typeof chrome === "object" && typeof chrome.runtime?.id === "string"').catch(() => false);
          if (ok) return s;
          await s.detach();
        }
        await sleep(100);
      }
      throw new Error(`Service worker for ${extensionId} not found`);
    },
    async extensionIds() {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return [...new Set(targetInfos.filter((t) => t.url.startsWith('chrome-extension://'))
        .map((t) => new URL(t.url).host))];
    },
    async close() {
      cdp.close();
      proc.kill('SIGKILL');
      await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

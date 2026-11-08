#!/usr/bin/env node
// Chrome Web Store images, English and Chinese, from the real UI renders:
//
//   node scripts/screenshots.mjs popup-store     # once, for the popup render
//   node scripts/screenshots.mjs options-connected
//   node scripts/store-images.mjs
//
// Output: store/images/ — screenshot-{1,2,3}-{en,zh}.png (1280×800), promo-small-{en,zh}.png
// (440×280), marquee-{en,zh}.png (1400×560). Sizes are the ones the store asks for.

import { mkdir, readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome } from '../test/e2e/lib/chrome.js';
import { openTab, sleep } from './lib/page.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'screenshots');
const OUT = join(ROOT, 'store', 'images');

const T = {
  en: {
    lang: 'en',
    heroTitle: 'Let Claude Code use your browser',
    heroSub: 'Over your own connection. No third-party relay in between.',
    points: ['Only the tabs you share with it', 'Every message encrypted end to end', 'Open source, no telemetry'],
    howTitle: 'Your browser, your server, your Claude Code',
    howSub: 'The extension connects out to a small service you run next to Claude Code.',
    nodes: [
      ['Chrome', 'with the cctether extension'],
      ['cctether service', 'on your computer or server'],
      ['Claude Code', 'or any MCP client'],
    ],
    link1: 'encrypted end to end',
    link2: 'MCP',
    noRelay: 'No relay: not Anthropic’s, not ours',
    ways: [['Same computer', 'nothing to set up'], ['SSH tunnel', 'through your SSH connection'], ['Your own domain', 'HTTPS via Caddy or Cloudflare Tunnel']],
    pairTitle: 'Pair once.\nStay in control.',
    pairPoints: [
      ['Run one command', '`npx cctether@latest setup` on the computer with Claude Code, then paste the code it prints.'],
      ['Share tabs on purpose', 'Claude only sees tabs in the cctether tab group.'],
      ['Pause any time', 'One click in the toolbar stops every tool at once.'],
    ],
    tagline: 'Claude Code in your browser,\nover your own connection',
    marqueeSub: 'Read pages, take screenshots, click and type, check the console and network — in your real, signed-in Chrome.',
  },
  zh: {
    lang: 'zh-CN',
    heroTitle: '让 Claude Code 用上你的浏览器',
    heroLines: '让 Claude Code\n用上你的浏览器',
    heroSub: '走你自己的连接，中间不经过任何第三方中转。',
    points: ['只能用你共享给它的标签页', '每条消息端到端加密', '开源，没有遥测'],
    howTitle: '浏览器、服务器、Claude Code，都是你自己的',
    howSub: '插件主动连到你在 Claude Code 旁边跑的一个小服务。',
    nodes: [
      ['Chrome', '装上 cctether 插件'],
      ['cctether 服务', '在你的电脑或服务器上'],
      ['Claude Code', '或其他 MCP 客户端'],
    ],
    link1: '端到端加密',
    link2: 'MCP',
    noRelay: '没有中转：不经过 Anthropic，也不经过我们',
    ways: [['同一台电脑', '不用额外配置'], ['SSH 隧道', '借你的 SSH 连接'], ['自己的域名', 'HTTPS，用 Caddy 或 Cloudflare 隧道']],
    pairTitle: '配对一次，\n随时掌控。',
    pairPoints: [
      ['一条命令装好', '在跑 Claude Code 的电脑上运行 `npx cctether@latest setup`，把它显示的连接码粘贴进来。'],
      ['标签页你说了算', 'Claude 只能看到 cctether 标签组里的标签页。'],
      ['随时暂停', '点一下工具栏按钮，所有工具立刻停下。'],
    ],
    tagline: '让 Claude Code 用上你的浏览器，\n走你自己的连接',
    marqueeSub: '读页面、截图、点击输入、看控制台和网络请求，用的就是你已经登录的那个 Chrome。',
  },
};

const ICON = await readFile(join(ROOT, 'extension', 'icons', 'icon.svg'), 'utf8');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const rich = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --accent: #0f7f72; --accent-2: #1aae9c; --ink: #15191c; --ink-2: #4f5961; --ink-3: #87909a;
    --soft: #e6f4f1; --line: #dde3e7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
    color: var(--ink);
    -webkit-font-smoothing: antialiased;
  }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body {
    background:
      radial-gradient(1200px 700px at 85% 15%, rgba(26, 174, 156, 0.16), transparent 60%),
      radial-gradient(900px 600px at 0% 100%, rgba(15, 127, 114, 0.10), transparent 60%),
      linear-gradient(180deg, #f7fbfa 0%, #eef5f3 100%);
  }
  code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.92em;
         background: rgba(15, 127, 114, 0.09); color: #0c6f63; padding: 2px 7px; border-radius: 6px; white-space: nowrap; }
  .brand { display: flex; align-items: center; gap: 14px; font-weight: 700; font-size: 28px; letter-spacing: -0.01em; }
  .brand svg { width: 52px; height: 52px; }
  h1 { font-size: 52px; line-height: 1.12; letter-spacing: -0.02em; font-weight: 750; }
  html[lang="zh-CN"] h1 { letter-spacing: 0; line-height: 1.25; }
  .sub { font-size: 21px; line-height: 1.5; color: var(--ink-2); }
  .points { list-style: none; display: grid; gap: 16px; }
  .points li { display: flex; align-items: center; gap: 14px; font-size: 20px; font-weight: 550; }
  .tick { flex: none; width: 30px; height: 30px; border-radius: 50%; background: var(--soft); display: grid; place-items: center; }
  .tick svg { width: 16px; height: 16px; }
  .card { background: #fff; border-radius: 18px; box-shadow: 0 30px 70px rgba(16, 40, 36, 0.18), 0 3px 10px rgba(16, 40, 36, 0.08); overflow: hidden; }
`;
const TICK = '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="#0f7f72" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const page = (t, body, extraCss = '') => `<!doctype html><html lang="${t.lang}"><head><meta charset="utf-8"><style>${CSS}${extraCss}</style></head><body>${body}</body></html>`;
const brand = '<div class="brand">' + ICON + '<span>cctether</span></div>';

function hero(t, img) {
  return page(t, `
    <div class="wrap">
      <div class="text">
        ${brand}
        <h1>${rich(t.heroLines ?? t.heroTitle)}</h1>
        <p class="sub">${esc(t.heroSub)}</p>
        <ul class="points">${t.points.map((p) => `<li><span class="tick">${TICK}</span>${esc(p)}</li>`).join('')}</ul>
      </div>
      <div class="shot"><div class="card"><img src="${img}"></div></div>
    </div>`, `
    .wrap { position: absolute; inset: 0; display: grid; grid-template-columns: 1fr 440px; align-items: center; gap: 56px; padding: 0 96px 0 104px; }
    .text { display: grid; gap: 30px; align-content: center; }
    .text h1 { margin-top: 18px; }
    .text .points { margin-top: 10px; }
    .shot { display: grid; place-items: center; }
    .shot .card { width: 396px; border-radius: 16px; }
    .shot img { display: block; width: 396px; }`);
}

function how(t) {
  const node = ([a, b], i) => `
    <div class="node${i === 1 ? ' mid' : ''}">
      <div class="nicon">${i === 0 ? ICON : i === 1 ? SERVER : CLI}</div>
      <div class="nt">${esc(a)}</div><div class="ns">${esc(b)}</div>
    </div>`;
  const link = (label, lock) => `<div class="link"><div class="lab">${lock ? LOCK : ''}${esc(label)}</div><div class="arrow"><span></span></div></div>`;
  return page(t, `
    <div class="wrap">
      <div class="head">${brand}<h2>${esc(t.howTitle)}</h2><p class="sub">${esc(t.howSub)}</p></div>
      <div class="flow">${node(t.nodes[0], 0)}${link(t.link1, true)}${node(t.nodes[1], 1)}${link(t.link2, false)}${node(t.nodes[2], 2)}</div>
      <div class="norelay"><span class="x">✕</span>${esc(t.noRelay)}</div>
      <div class="ways">${t.ways.map(([a, b]) => `<div class="way"><b>${esc(a)}</b><span>${esc(b)}</span></div>`).join('')}</div>
    </div>`, `
    .wrap { position: absolute; inset: 0; padding: 70px 96px; display: grid; grid-template-rows: auto 1fr auto auto; gap: 34px; }
    .head { display: grid; gap: 16px; }
    h2 { font-size: 40px; letter-spacing: -0.015em; margin-top: 10px; }
    .flow { display: grid; grid-template-columns: 1fr 190px 1fr 150px 1fr; align-items: stretch; height: 210px; align-self: center; }
    .link { align-self: center; }
    .node { background: #fff; border-radius: 20px; padding: 30px 20px; text-align: center; display: grid; justify-items: center; align-content: center; gap: 8px;
            box-shadow: 0 18px 40px rgba(16, 40, 36, 0.12), 0 2px 6px rgba(16, 40, 36, 0.06); }
    .node.mid { outline: 2px solid rgba(15, 127, 114, 0.35); }
    .nicon { width: 64px; height: 64px; margin-bottom: 8px; display: grid; place-items: center; }
    .nicon svg { width: 64px; height: 64px; }
    .nt { font-size: 22px; font-weight: 700; }
    .ns { font-size: 17px; color: var(--ink-2); }
    .link { display: grid; gap: 10px; justify-items: center; padding: 0 10px; }
    .lab { font-size: 15px; font-weight: 600; color: var(--accent); display: flex; gap: 6px; align-items: center; white-space: nowrap; }
    .lab svg { width: 15px; height: 15px; }
    .arrow { width: 100%; height: 14px; position: relative; }
    .arrow span { position: absolute; left: 4px; right: 4px; top: 6px; height: 2.5px; border-radius: 2px;
                  background: linear-gradient(90deg, var(--accent-2), var(--accent)); }
    .arrow::before, .arrow::after { content: ''; position: absolute; top: 2px; width: 9px; height: 9px; border-top: 2.5px solid var(--accent); border-right: 2.5px solid var(--accent); }
    .arrow::after { right: 5px; transform: rotate(45deg); }
    .arrow::before { left: 5px; transform: rotate(-135deg); border-color: var(--accent-2); }
    .norelay { justify-self: center; display: flex; align-items: center; gap: 12px; font-size: 19px; font-weight: 600; color: var(--ink-2);
               background: rgba(255,255,255,0.7); border: 1px solid var(--line); padding: 12px 22px; border-radius: 999px; }
    .x { width: 26px; height: 26px; border-radius: 50%; background: #fdeded; color: #c0353b; display: grid; place-items: center; font-size: 13px; font-weight: 800; }
    .ways { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
    .way { background: rgba(255,255,255,0.75); border: 1px solid var(--line); border-radius: 14px; padding: 16px 20px; display: grid; gap: 4px; }
    .way b { font-size: 18px; }
    .way span { font-size: 15px; color: var(--ink-3); }`);
}

function pair(t, img) {
  return page(t, `
    <div class="wrap">
      <div class="text">
        ${brand}
        <h2>${rich(t.pairTitle)}</h2>
        <div class="steps">${t.pairPoints.map(([a, b], i) => `<div class="step"><span class="n">${i + 1}</span><div><b>${esc(a)}</b><p>${rich(b)}</p></div></div>`).join('')}</div>
      </div>
      <div class="window">
        <div class="bar"><i></i><i></i><i></i><span>cctether</span></div>
        <div class="view"><img src="${img}"></div>
      </div>
    </div>`, `
    .wrap { position: absolute; inset: 0; display: grid; grid-template-columns: 450px 1fr; gap: 56px; align-items: center; padding: 0 0 0 96px; }
    .text { display: grid; gap: 28px; }
    h2 { font-size: 46px; line-height: 1.15; letter-spacing: -0.02em; margin-top: 12px; }
    html[lang="zh-CN"] h2 { letter-spacing: 0; line-height: 1.3; }
    .steps { display: grid; gap: 22px; }
    .step { display: grid; grid-template-columns: 34px 1fr; gap: 14px; align-items: start; }
    .n { width: 34px; height: 34px; border-radius: 50%; background: var(--accent); color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 16px; }
    .step b { font-size: 20px; display: block; margin: 4px 0 6px; }
    .step p { font-size: 16.5px; line-height: 1.55; color: var(--ink-2); }
    .window { height: 640px; border-radius: 16px 0 0 16px; background: #f4f5f6; overflow: hidden;
              box-shadow: 0 30px 70px rgba(16, 40, 36, 0.18), 0 3px 10px rgba(16, 40, 36, 0.08); }
    .bar { height: 40px; background: #e9ecee; display: flex; align-items: center; gap: 8px; padding: 0 16px; border-bottom: 1px solid #dde2e5; }
    .bar i { width: 12px; height: 12px; border-radius: 50%; background: #cfd5d9; }
    .bar span { margin-left: 14px; font-size: 13px; color: var(--ink-2); background: #fff; padding: 4px 14px; border-radius: 8px; }
    .view { height: 600px; overflow: hidden; }
    /* The render is 1000 CSS px wide with the page column in the middle: show it 1:1, cropped. */
    .view img { width: 1000px; height: auto; display: block; margin: -10px 0 0 -160px; }`);
}

function promo(t) {
  return page(t, `
    <svg class="deco" viewBox="0 0 128 128"><path d="M36 78C52 38 76 90 92 50" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/><circle cx="36" cy="78" r="7" fill="#fff"/><circle cx="92" cy="50" r="7" fill="#fff"/></svg>
    <div class="tile">
      <div class="row">${ICON_WHITE}<span>cctether</span></div>
      <p>${rich(t.tagline)}</p>
    </div>`, `
    .deco { position: absolute; width: 300px; height: 300px; right: -70px; bottom: -90px; opacity: 0.1; }
    body { background: linear-gradient(135deg, #12907f 0%, #0b6c61 100%); }
    .tile { position: absolute; inset: 0; padding: 44px 40px; display: grid; align-content: center; gap: 22px; color: #fff; }
    .row { display: flex; align-items: center; gap: 14px; font-size: 36px; font-weight: 750; letter-spacing: -0.01em; }
    .row svg { width: 58px; height: 58px; }
    p { font-size: 19px; line-height: 1.45; color: rgba(255,255,255,0.9); font-weight: 500; }`);
}

function marquee(t, img) {
  return page(t, `
    <div class="wrap">
      <div class="text">
        <div class="row">${ICON_WHITE}<span>cctether</span></div>
        <h1>${esc(t.heroTitle)}</h1>
        <p>${esc(t.marqueeSub)}</p>
      </div>
      <div class="shot"><img src="${img}"></div>
    </div>`, `
    body { background: radial-gradient(900px 500px at 90% 0%, rgba(255,255,255,0.12), transparent 60%), linear-gradient(135deg, #12907f 0%, #0b6259 100%); }
    .wrap { position: absolute; inset: 0; display: grid; grid-template-columns: 1fr 400px; gap: 56px; padding: 0 110px 0 100px; align-items: center; color: #fff; }
    .text { display: grid; gap: 22px; }
    .row { display: flex; align-items: center; gap: 14px; font-size: 30px; font-weight: 750; }
    .row svg { width: 52px; height: 52px; }
    h1 { font-size: 46px; color: #fff; text-wrap: balance; }
    p { font-size: 21px; line-height: 1.5; color: rgba(255,255,255,0.88); max-width: 680px; }
    .shot { align-self: start; margin-top: 70px; border-radius: 16px; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,0.35); }
    .shot img { display: block; width: 400px; }`);
}

// Small inline icons for the diagram.
const LOCK = '<svg viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="7" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 7V5.2a2.5 2.5 0 015 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
const SERVER = '<svg viewBox="0 0 64 64"><rect x="10" y="12" width="44" height="17" rx="5" fill="#e6f4f1" stroke="#0f7f72" stroke-width="2.5"/><rect x="10" y="35" width="44" height="17" rx="5" fill="#e6f4f1" stroke="#0f7f72" stroke-width="2.5"/><circle cx="20" cy="20.5" r="2.6" fill="#0f7f72"/><circle cx="20" cy="43.5" r="2.6" fill="#0f7f72"/><path d="M30 20.5h16M30 43.5h16" stroke="#0f7f72" stroke-width="2.5" stroke-linecap="round"/></svg>';
const CLI = '<svg viewBox="0 0 64 64"><rect x="8" y="12" width="48" height="40" rx="7" fill="#15191c"/><path d="M18 26l8 6-8 6" fill="none" stroke="#7fe0cf" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M31 39h14" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>';
const ICON_WHITE = '<svg viewBox="0 0 128 128"><circle cx="64" cy="64" r="58" fill="#fff"/><path d="M36 78C52 38 76 90 92 50" fill="none" stroke="#0f7f72" stroke-width="12" stroke-linecap="round"/><circle cx="36" cy="78" r="10.4" fill="#0f7f72"/><circle cx="92" cy="50" r="10.4" fill="#0f7f72"/></svg>';

// ---------------------------------------------------------------------------------------------

const need = (f) => access(join(SHOTS, f)).then(() => pathToFileURL(join(SHOTS, f)).href, () => {
  throw new Error(`Missing ${f}. Run: node scripts/screenshots.mjs popup-store && node scripts/screenshots.mjs options-connected`);
});

await mkdir(OUT, { recursive: true });
const tmp = await mkdtemp(join(tmpdir(), 'cct-store-'));
const chrome = await launchChrome({ headless: true });
try {
  const tab = await openTab(chrome);
  await tab.scheme(false);
  const jobs = [];
  for (const lang of ['en', 'zh']) {
    const t = T[lang];
    const popup = await need(`popup-store-${lang}-light.png`);
    const options = await need(`options-connected-${lang}-light.png`);
    jobs.push(
      [`screenshot-1-${lang}.png`, 1280, 800, hero(t, popup)],
      [`screenshot-2-${lang}.png`, 1280, 800, how(t)],
      [`screenshot-3-${lang}.png`, 1280, 800, pair(t, options)],
      [`promo-small-${lang}.png`, 440, 280, promo(t)],
      [`marquee-${lang}.png`, 1400, 560, marquee(t, popup)],
    );
  }
  for (const [name, w, h, html] of jobs) {
    const file = join(tmp, name.replace('.png', '.html'));
    await writeFile(file, html);
    await tab.viewport(w, h, 1);
    await tab.goto(pathToFileURL(file).href);
    await tab.evaluate('document.fonts.ready.then(() => 0)');
    await sleep(150);
    await tab.screenshot(join(OUT, name), { x: 0, y: 0, width: w, height: h });
    console.log(`store/images/${name}  ${w}×${h}`);
  }
} finally {
  await chrome.close();
  await rm(tmp, { recursive: true, force: true });
}

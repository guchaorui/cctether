#!/usr/bin/env node
// Generate cctether's icons: the SVG sources and the PNGs the extension uses.
//
//   node scripts/icons.mjs
//
// Writes
//   extension/icons/icon.svg                 master logo (also used inside the popup/settings page)
//   extension/icons/icon-{16,32,48,128}.png  manifest icons
//   extension/icons/state/<state>.svg        toolbar state sources (32×32 grid)
//   extension/icons/state/<state>-{16,32}.png toolbar icons set by background/badge.js
//
// The mark: a round badge with two nodes joined by a slack line — a tether.
// Toolbar states differ by colour (teal = connected, grey = everything else), by glyph (pause bars)
// and by a small status dot in the corner. PNGs are rasterised by headless Chrome for Testing.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = join(ROOT, 'extension', 'icons');

export const STATES = ['connected', 'connecting', 'disconnected', 'replaced', 'paused', 'unpaired'];

const C = {
  teal: '#12998a',
  tealTop: '#1aae9c',
  tealBottom: '#0d8174',
  grey: '#8a9096',
  blue: '#3b82f6',
  red: '#e5484d',
  amber: '#eb9a12',
  white: '#ffffff',
};

/** Geometry on a 32 grid; `bold` thickens strokes for the 16 px rendering. */
function geometry(bold) {
  if (bold) {
    // 16 px: nodes sit on pixel centres, thicker line, larger dot.
    return {
      r: 15,
      stroke: 3.8,
      node: 3.4,
      wave: 'M9 21C13 9 19 23 23 11',
      a: [9, 21],
      b: [23, 11],
      dot: { cx: 25, cy: 25, r: 7, cut: 9.4 },
    };
  }
  return {
    r: 14.5,
    stroke: 3,
    node: 2.6,
    wave: 'M9 19.5C13 9.5 19 22.5 23 12.5',
    a: [9, 19.5],
    b: [23, 12.5],
    dot: { cx: 25, cy: 25, r: 6.4, cut: 8.6 },
  };
}

function waveGlyph(g, color = C.white) {
  return `<path d="${g.wave}" fill="none" stroke="${color}" stroke-width="${g.stroke}" stroke-linecap="round"/>`
    + `<circle cx="${g.a[0]}" cy="${g.a[1]}" r="${g.node}" fill="${color}"/>`
    + `<circle cx="${g.b[0]}" cy="${g.b[1]}" r="${g.node}" fill="${color}"/>`;
}

function pauseGlyph(bold) {
  return bold
    ? `<rect x="10" y="8" width="4" height="16" rx="1" fill="${C.white}"/><rect x="18" y="8" width="4" height="16" rx="1" fill="${C.white}"/>`
    : `<rect x="10.8" y="9.5" width="3.8" height="13" rx="1.2" fill="${C.white}"/><rect x="17.4" y="9.5" width="3.8" height="13" rx="1.2" fill="${C.white}"/>`;
}

/** Small white glyph inside the status dot (32 px only; at 16 px the colour carries it). */
function dotGlyph(state, d) {
  const { cx, cy } = d;
  if (state === 'disconnected') {
    return `<rect x="${cx - 1}" y="${cy - 4}" width="2" height="4.6" rx="1" fill="#fff"/><circle cx="${cx}" cy="${cy + 2.9}" r="1.15" fill="#fff"/>`;
  }
  if (state === 'connecting') {
    return [-2.9, 0, 2.9].map((dx) => `<circle cx="${cx + dx}" cy="${cy}" r="1.1" fill="#fff"/>`).join('');
  }
  if (state === 'replaced') {
    // one double-headed arrow: "taken over"
    return `<path d="M${cx - 3.3} ${cy}h6.6M${cx - 1.5} ${cy - 2}l-1.9 2 1.9 2M${cx + 1.5} ${cy - 2}l1.9 2-1.9 2" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return '';
}

/** Toolbar icon for one state, drawn on a 32×32 grid. */
export function stateSvg(state, { small = false } = {}) {
  const g = geometry(small);
  const fill = state === 'connected' ? C.teal : C.grey;
  const glyph = state === 'paused' ? pauseGlyph(small) : waveGlyph(g);
  const dotColor = { connecting: C.blue, disconnected: C.red, replaced: C.amber }[state];
  const d = g.dot;
  const mask = dotColor
    ? `<defs><mask id="m"><rect width="32" height="32" fill="#fff"/><circle cx="${d.cx}" cy="${d.cy}" r="${d.cut}" fill="#000"/></mask></defs>`
    : '';
  const body = `<g${dotColor ? ' mask="url(#m)"' : ''}><circle cx="16" cy="16" r="${g.r}" fill="${fill}"/>${glyph}</g>`;
  const dot = dotColor
    ? `<circle cx="${d.cx}" cy="${d.cy}" r="${d.r}" fill="${dotColor}"/>${small ? '' : dotGlyph(state, d)}`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">${mask}${body}${dot}</svg>\n`;
}

/** Master logo on a 128 grid with a soft gradient. */
export function brandSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.tealTop}"/>
      <stop offset="1" stop-color="${C.tealBottom}"/>
    </linearGradient>
  </defs>
  <circle cx="64" cy="64" r="58" fill="url(#g)"/>
  <circle cx="64" cy="64" r="57.25" fill="none" stroke="#000" stroke-opacity=".08" stroke-width="1.5"/>
  <path d="M36 78C52 38 76 90 92 50" fill="none" stroke="#fff" stroke-width="12" stroke-linecap="round"/>
  <circle cx="36" cy="78" r="10.4" fill="#fff"/>
  <circle cx="92" cy="50" r="10.4" fill="#fff"/>
</svg>
`;
}

/** Brand mark for small manifest sizes: same as the connected toolbar icon. */
function brandSmallSvg(small) {
  return stateSvg('connected', { small });
}

async function rasterise(page, svg, size, out) {
  const html = `<!doctype html><html><body style="margin:0;background:transparent">`
    + svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`)
    + `</body></html>`;
  await page.goto('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await page.screenshot(out, { x: 0, y: 0, width: size, height: size });
}

async function main() {
  const { launchChrome } = await import('../test/e2e/lib/chrome.js');
  const { openTab } = await import('./lib/page.mjs');
  await mkdir(join(ICONS, 'state'), { recursive: true });

  await writeFile(join(ICONS, 'icon.svg'), brandSvg());
  for (const s of STATES) await writeFile(join(ICONS, 'state', `${s}.svg`), stateSvg(s));

  const chrome = await launchChrome();
  try {
    const page = await openTab(chrome);
    await page.viewport(256, 256, 1);
    await page.transparent();
    await rasterise(page, brandSmallSvg(true), 16, join(ICONS, 'icon-16.png'));
    await rasterise(page, brandSmallSvg(false), 32, join(ICONS, 'icon-32.png'));
    await rasterise(page, brandSvg(), 48, join(ICONS, 'icon-48.png'));
    await rasterise(page, brandSvg(), 128, join(ICONS, 'icon-128.png'));
    for (const s of STATES) {
      await rasterise(page, stateSvg(s, { small: true }), 16, join(ICONS, 'state', `${s}-16.png`));
      await rasterise(page, stateSvg(s), 32, join(ICONS, 'state', `${s}-32.png`));
    }
  } finally {
    await chrome.close();
  }
  console.log('icons written to', ICONS);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

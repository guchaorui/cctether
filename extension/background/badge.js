// Toolbar button: icon + tooltip that show the connection state at a glance.
// Runs in the service worker. Icons are pre-rendered PNGs (scripts/icons.mjs).

import { DEFAULT_SETTINGS, DEFAULT_STATUS } from '../shared/contract.js';
import { resolveLang, translator } from '../shared/i18n.js';

/**
 * Which toolbar icon to show.
 * @returns {'unpaired'|'paused'|'connected'|'connecting'|'disconnected'|'replaced'}
 */
export function iconState(status, settings) {
  const s = { ...DEFAULT_STATUS, ...status };
  const st = { ...DEFAULT_SETTINGS, ...settings };
  if (s.conn === 'unpaired') return 'unpaired';
  if (st.paused) return 'paused';
  if (s.conn === 'connected' || s.conn === 'connecting' || s.conn === 'replaced') return s.conn;
  return 'disconnected';
}

/** Localised tooltip for the toolbar button. */
export function actionTitle(status, settings) {
  const s = { ...DEFAULT_STATUS, ...status };
  const t = translator(resolveLang({ ...DEFAULT_SETTINGS, ...settings }.lang));
  const state = iconState(s, settings);
  if (state === 'connected') return t('badge.connected', { server: s.server ?? '' });
  if (state === 'disconnected') {
    const code = s.error?.code;
    const key = code && t(`err.${code}.title`) !== `err.${code}.title` ? `err.${code}.title` : 'err.unknown.title';
    return t('badge.disconnected', { reason: t(key) });
  }
  return t(`badge.${state}`);
}

let applied = '';

/**
 * Update the toolbar icon and tooltip. Cheap to call often: does nothing if nothing visible changed.
 * Call on service worker start-up and whenever Status or Settings change.
 */
export async function updateActionIcon(status, settings) {
  const state = iconState(status, settings);
  const title = actionTitle(status, settings);
  const key = `${state}\n${title}`;
  if (key === applied) return;
  applied = key;
  try {
    await Promise.all([
      chrome.action.setIcon({
        path: { 16: `/icons/state/${state}-16.png`, 32: `/icons/state/${state}-32.png` },
      }),
      chrome.action.setTitle({ title }),
      chrome.action.setBadgeText({ text: '' }),
    ]);
  } catch (e) {
    applied = '';
    console.warn('cctether: could not update the toolbar icon:', e?.message ?? e);
  }
}

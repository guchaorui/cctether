// UI language: resolve the user's choice and translate keys from strings.js.
// Works in pages and in the service worker (no DOM needed here).

import { STRINGS } from './strings.js';

/** The language Chrome's UI is in (falls back to navigator.language). */
export function browserLanguage() {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return globalThis.navigator?.language ?? 'en';
  }
}

/**
 * settings.lang ('auto' | 'zh' | 'en') → the language to show ('zh' | 'en').
 * 'auto' follows the browser: any zh* locale → 'zh', everything else → 'en'.
 */
export function resolveLang(pref, browserLang = browserLanguage()) {
  if (pref === 'zh' || pref === 'en') return pref;
  return String(browserLang || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** BCP 47 tag for <html lang> and Intl. */
export function localeOf(lang) {
  return lang === 'zh' ? 'zh-CN' : 'en';
}

/**
 * Translator for one language. Missing keys fall back to English, then to the key itself.
 * @returns {(key: string, params?: Record<string, any>) => string}
 */
export function translator(lang) {
  const pack = STRINGS[lang] ?? STRINGS.en;
  return (key, params = {}) => {
    const v = pack[key] ?? STRINGS.en[key];
    if (v === undefined) return key;
    const out = typeof v === 'function'
      ? v(params)
      : v.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m));
    return out.replace(/Claude Code/g, 'Claude\u00a0Code');   // never break the product name
  };
}

/** "12 s" / "2 min" for a duration in ms (rounded up). */
export function formatWait(ms, t) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return t('retry.seconds', { n: s });
  return t('retry.minutes', { n: Math.ceil(s / 60) });
}

/** "14:03" (24-hour) in the UI language. */
export function formatClock(ms, lang) {
  return new Intl.DateTimeFormat(localeOf(lang), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(ms));
}

/** Full date and time, e.g. for "Paired on". */
export function formatDateTime(ms, lang) {
  return new Intl.DateTimeFormat(localeOf(lang), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
}

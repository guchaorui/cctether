// Turn CDP console/exception payloads into short plain text.

import { clip } from './util.js';

function previewValue(pr) {
  if (pr.type === 'string') return JSON.stringify(pr.value ?? '');
  if (pr.type === 'object' && pr.subtype !== 'null') {
    return pr.valuePreview ? previewToText(pr.valuePreview) : (pr.value || 'Object');
  }
  if (pr.type === 'function') return 'ƒ';
  if (pr.type === 'accessor') return '(...)';
  return String(pr.value);
}

function previewToText(p) {
  if (!p) return '';
  if (p.type !== 'object' || p.subtype === 'null') {
    return p.type === 'string' ? JSON.stringify(p.description ?? '') : String(p.description ?? '');
  }
  const more = p.overflow ? ', …' : '';
  if (p.subtype === 'node' || p.subtype === 'error' || p.subtype === 'regexp' || p.subtype === 'date') {
    return p.description ?? '';
  }
  if (p.entries) {
    const entries = p.entries.map((e) => (e.key ? `${previewToText(e.key)} => ${previewToText(e.value)}` : previewToText(e.value)));
    return `${p.description ?? ''} {${entries.join(', ')}${more}}`;
  }
  const props = (p.properties ?? []).map((pr) => {
    const v = previewValue(pr);
    return /^\d+$/.test(pr.name) && (p.subtype === 'array' || p.subtype === 'typedarray') ? v : `${pr.name}: ${v}`;
  });
  if (p.subtype === 'array' || p.subtype === 'typedarray') return `[${props.join(', ')}${more}]`;
  const prefix = p.description && p.description !== 'Object' ? `${p.description} ` : '';
  return `${prefix}{${props.join(', ')}${more}}`;
}

/** One Runtime.RemoteObject as text, the way the DevTools console would roughly show it. */
export function remoteToText(o) {
  if (!o) return '';
  switch (o.type) {
    case 'string': return o.value ?? '';
    case 'undefined': return 'undefined';
    case 'number':
    case 'bigint': return o.unserializableValue ?? String(o.value);
    case 'boolean': return String(o.value);
    case 'symbol': return o.description ?? 'Symbol()';
    case 'function': return clip(String(o.description || 'function').split('\n')[0], 120);
    case 'object':
      if (o.subtype === 'null') return 'null';
      if (o.subtype === 'error' || o.subtype === 'node') return o.description ?? o.className ?? 'Object';
      if (o.preview) return previewToText(o.preview);
      if ('value' in o) {
        try { return JSON.stringify(o.value); } catch { /* fall through */ }
      }
      return o.description ?? o.className ?? 'Object';
    default:
      return o.description ?? String(o.value ?? '');
  }
}

/** Console arguments → one line, applying %s/%d/%i/%f/%o/%O/%c substitutions in the first one. */
export function formatConsoleArgs(args = []) {
  if (!args.length) return '';
  const parts = [];
  let rest;
  if (args[0].type === 'string' && /%[sdifoOc]/.test(args[0].value ?? '')) {
    let i = 1;
    parts.push(String(args[0].value).replace(/%([sdifoOc%])/g, (m, f) => {
      if (f === '%') return '%';
      if (i >= args.length) return m;
      const a = args[i++];
      if (f === 'c') return '';
      if (f === 'd' || f === 'i') {
        const n = a.type === 'number' ? a.value : Number.NaN;
        return Number.isFinite(n) ? String(Math.trunc(n)) : (a.unserializableValue ?? 'NaN');
      }
      if (f === 'f') return a.type === 'number' ? String(a.value ?? a.unserializableValue) : 'NaN';
      return remoteToText(a);
    }));
    rest = args.slice(i);
  } else {
    rest = args;
  }
  for (const a of rest) parts.push(remoteToText(a));
  return parts.join(' ');
}

const LEVELS = { error: 'error', assert: 'error', warning: 'warning', warn: 'warning', debug: 'debug', verbose: 'debug', info: 'info' };
export const consoleLevel = (type) => LEVELS[type] ?? 'log';

/** Runtime.ExceptionDetails → "Uncaught Error: boom\n    at …" (message + first stack frames). */
export function exceptionToText(d) {
  if (!d) return 'Uncaught exception';
  const ex = d.exception;
  const desc = ex ? (ex.description ?? remoteToText(ex)) : '';
  let text = d.text || 'Uncaught';
  if (desc) text = /^Uncaught/.test(text) ? `${text} ${desc}` : `${text}: ${desc}`;
  const lines = text.split('\n');
  return lines.slice(0, 6).join('\n') + (lines.length > 6 ? '\n    …' : '');
}

/** "url:line" from a stack trace or explicit url/line (CDP lines are 0-based). */
export function location(url, lineNumber, stackTrace) {
  const f = stackTrace?.callFrames?.find((c) => c.url) ?? null;
  const u = url || f?.url || '';
  const line = url ? lineNumber : f?.lineNumber;
  if (!u) return '';
  return Number.isInteger(line) ? `${u}:${line + 1}` : u;
}

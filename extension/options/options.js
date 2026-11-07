// Settings page: pairing, connection status, language, how it works, help, about.

import {
  h, rich, icon, applyStatic, statusView, retryText, stateBadge,
  loadState, onStateChange, send, languageFor, setDocumentLanguage, setLanguage, MSG, REPO_URL,
} from '../shared/ui.js';
import { parsePairingCode, displayServer } from '../shared/pairing.js';
import { formatDateTime } from '../shared/i18n.js';

const $ = (id) => document.getElementById(id);
const els = {
  status: $('conn-status'),
  form: $('pair-form'),
  formTitle: $('pair-title'),
  code: $('code'),
  validation: $('validation'),
  submit: $('pair-submit'),
  cancel: $('pair-cancel'),
  copy: $('copy-cmd'),
  details: $('paired-details'),
  lang: $('lang'),
  dialog: $('unpair-dialog'),
};

let state = null;
let changing = false;     // showing the pairing form while already paired
let pairing = false;      // a 'pair' request is in flight
let check = null;         // result of parsePairingCode for the current input, or a reply error
let flash = null;         // { text } shown once after pairing succeeds
let copied = false;
let busyAction = null;
let retryEl = null;

async function main() {
  $('secret-icon').append(icon('lock', { size: 14 }));
  for (const li of document.querySelectorAll('.facts li')) {
    li.prepend(h('span', { class: 'fact-icon' }, icon(li.dataset.icon, { size: 16 })));
  }
  for (const s of document.querySelectorAll('.faq summary')) s.append(icon('chevron', { size: 16, cls: 'chev' }));
  $('source-link').href = REPO_URL;
  $('source-link').append(icon('external', { size: 13 }));
  $('ext-id').textContent = chrome.runtime.id;

  els.code.addEventListener('input', onCodeInput);
  els.form.addEventListener('submit', onSubmit);
  els.cancel.addEventListener('click', () => { changing = false; resetForm(); render(); });
  els.copy.addEventListener('click', copyCommand);
  els.lang.addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) setLanguage(b.dataset.lang);
  });
  els.lang.addEventListener('keydown', onLangKey);
  els.dialog.addEventListener('close', async () => {
    if (els.dialog.returnValue === 'unpair') {
      await send(MSG.unpair);
      changing = false;
      flash = null;
      resetForm();
    }
  });

  state = await loadState();
  if (location.hash === '#pair' && state.pairing) changing = true;
  render();
  if (location.hash === '#pair' || !state.pairing) els.code.focus();
  onStateChange(async () => { state = await loadState(); render(); });
  setInterval(() => {
    if (retryEl) retryEl.textContent = retryText(Number(retryEl.dataset.at), languageFor(state.settings).t);
  }, 500);
}

// ---------------------------------------------------------------------------------------------

function render() {
  const { lang, t } = languageFor(state.settings);
  setDocumentLanguage(lang, t, 'opt.title');
  applyStatic(document, t);
  $('version').textContent = t('opt.about.version', { version: chrome.runtime.getManifest().version });

  for (const b of els.lang.querySelectorAll('[data-lang]')) {
    const on = b.dataset.lang === state.settings.lang;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }

  const paired = !!state.pairing;
  const showForm = !paired || changing;
  els.form.hidden = !showForm;
  els.formTitle.textContent = t(paired ? 'opt.pair.changeHeading' : 'opt.pair.heading');
  els.cancel.hidden = !paired;
  els.copy.replaceChildren(icon(copied ? 'check' : 'copy', { size: 14 }), t(copied ? 'opt.pair.copied' : 'opt.pair.copy'));
  renderValidation(t);

  retryEl = null;
  els.status.replaceChildren(paired ? renderStatus(t) : '');
  els.status.hidden = !paired;
  els.details.replaceChildren(paired && !changing ? renderDetails(t, lang) : '');
  els.details.hidden = !paired || changing;
}

function renderStatus(t) {
  const view = statusView(state.status, state.settings, state.pairing, t, chrome.runtime.id);
  let retry = null;
  if (view.retryAt) {
    retry = h('span', { class: 'retry', 'data-at': view.retryAt, 'aria-live': 'off' }, retryText(view.retryAt, t));
    retryEl = retry;
  }
  const button = (a) => h('button', {
    type: 'button',
    class: `btn ${a.kind === 'ghost' ? 'btn-secondary btn-sm' : `btn-${a.kind}`}`,
    disabled: busyAction === a.id,
    onclick: () => runAction(a.id),
  }, a.icon && icon(a.icon, { size: 14 }), a.label);
  const headActions = view.actions.filter((a) => a.kind === 'ghost').map(button);
  const actions = view.actions.filter((a) => a.kind !== 'ghost').map(button);

  return h('div', { class: `conn tone-${view.tone}`, 'data-kind': view.kind },
    flash && h('p', { class: 'msg tone-ok flash' }, icon('check', { size: 15 }), h('span', {}, rich(flash))),
    h('div', { class: 'conn-head' },
      stateBadge(view),
      h('div', { class: 'conn-text' },
        h('p', { class: 'conn-title' }, view.title),
        view.server && h('p', { class: 'conn-server' }, view.server),
        view.link && h('p', { class: 'conn-link' },
          h('span', { class: `dot ${view.link.up ? 'tone-ok' : 'tone-neutral'}` }), h('span', {}, view.link.text)),
      ),
      headActions,
    ),
    view.body && h('p', { class: 'conn-body' }, rich(view.body)),
    view.detail && h('p', { class: 'conn-detail' }, view.detail),
    (actions.length || retry) && h('div', { class: 'conn-actions' },
      actions,
      retry && h('span', { class: 'retry-wrap' }, icon('clock', { size: 13 }), retry)),
  );
}

function renderDetails(t, lang) {
  const p = state.pairing;
  const fp = String(p.fingerprint ?? '').replace(/^(.{4})(.+)$/, '$1 $2');
  return h('div', { class: 'details' },
    h('dl', { class: 'facts-table' },
      h('div', {}, h('dt', {}, t('opt.server')), h('dd', { class: 'mono' }, p.url)),
      h('div', {},
        h('dt', {}, t('opt.fingerprint')),
        h('dd', {}, h('span', { class: 'mono fingerprint' }, fp), h('span', { class: 'dd-hint' }, rich(t('opt.fingerprint.hint'))))),
      p.pairedAt && h('div', {}, h('dt', {}, t('opt.pairedAt')), h('dd', {}, formatDateTime(p.pairedAt, lang))),
    ),
    h('div', { class: 'details-actions' },
      h('button', { type: 'button', class: 'btn btn-secondary', onclick: startChange }, t('opt.change')),
      h('button', { type: 'button', class: 'btn btn-danger', onclick: () => els.dialog.showModal() }, t('opt.unpair')),
    ),
  );
}

function renderValidation(t) {
  const v = els.validation;
  if (!check) { v.hidden = true; v.replaceChildren(); els.submit.disabled = true; return; }
  v.hidden = false;
  let tone, ico, text;
  if (check.ok) { tone = 'ok'; ico = 'check'; text = t('opt.pair.valid', { server: displayServer(check.url) }); }
  else if (check.error === 'invalid_code' || check.error === 'insecure_url') { tone = 'danger'; ico = 'alert'; text = t(`opt.pair.${check.error}`); }
  else { tone = 'danger'; ico = 'alert'; text = t('opt.pair.failed'); }
  v.className = `validation msg tone-${tone}`;
  v.replaceChildren(icon(ico, { size: 15 }), h('span', {}, rich(text)));
  els.submit.disabled = !check.ok || pairing;
  els.code.setAttribute('aria-invalid', String(!check.ok));
}

// ---------------------------------------------------------------------------------------------

function onCodeInput() {
  const text = els.code.value.trim();
  if (!text) { check = null; }
  else {
    const r = parsePairingCode(text);
    check = r.ok ? { ok: true, url: r.url } : { ok: false, error: r.error };   // never keep the key around
  }
  flash = null;
  renderValidation(languageFor(state.settings).t);
}

async function onSubmit(e) {
  e.preventDefault();
  if (!check?.ok || pairing) return;
  pairing = true;
  renderValidation(languageFor(state.settings).t);
  const reply = await send(MSG.pair, { code: els.code.value.trim() });
  pairing = false;
  if (reply.ok) {
    const server = reply.server ?? check.url;
    resetForm();
    changing = false;
    flash = languageFor(state.settings).t('opt.pair.done', { server: displayServer(server) });
    state = await loadState();
    render();
  } else {
    check = { ok: false, error: reply.error };
    renderValidation(languageFor(state.settings).t);
  }
}

function resetForm() {
  els.code.value = '';
  els.code.removeAttribute('aria-invalid');
  check = null;
}

function startChange() {
  changing = true;
  flash = null;
  resetForm();
  render();
  els.code.focus();
}

async function copyCommand() {
  try {
    await navigator.clipboard.writeText($('command-text').textContent.trim());
    copied = true;
    render();
    setTimeout(() => { copied = false; render(); }, 1600);
  } catch { /* clipboard unavailable: the command is visible anyway */ }
}

async function runAction(id) {
  if (id === 'setup' || id === 'pairAgain') return startChange();
  if (id === 'getUpdate') return void chrome.tabs.create({ url: REPO_URL });
  busyAction = id;
  render();
  if (id === 'pause') await send(MSG.setPaused, { paused: true });
  else if (id === 'resume') await send(MSG.setPaused, { paused: false });
  else if (id === 'reconnect') await send(MSG.reconnect);
  busyAction = null;
  state = await loadState();
  render();
}

function onLangKey(e) {
  const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  if (!(e.key in keys)) return;
  e.preventDefault();
  const btns = [...els.lang.querySelectorAll('[data-lang]')];
  const i = btns.indexOf(document.activeElement);
  const next = btns[(i + keys[e.key] + btns.length) % btns.length];
  next.focus();
  setLanguage(next.dataset.lang);
}

main();

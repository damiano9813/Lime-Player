// Utilità, toast, finestra modale, scorciatoie e icone.
'use strict';

// ------------------------------------------------------------------ utils
const $ = (id) => document.getElementById(id);
const TAURI = window.__TAURI__;
const invoke = (cmd, args) => {
  if (!TAURI || !TAURI.core) return Promise.reject('API Tauri non disponibile: avvia l\'app con "cargo tauri dev".');
  return TAURI.core.invoke(cmd, args || {});
};
const errText = (e) => (typeof e === 'string' ? e : (e && e.message) ? e.message : JSON.stringify(e));
const { escapeHtml, normKey, initials, fmtTime, debounce } = XPCore;
const lsGet = (k, def) => { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage pieno o disabilitato */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* ignorato */ } };

let toastTimer = null;
const TOAST_ICONS = {
  error: '<svg class="w-4 h-4 shrink-0 text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/></svg>',
  ok: '<svg class="w-4 h-4 shrink-0 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>',
  info: '<svg class="w-4 h-4 shrink-0 text-info" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 11v5M12 8h.01"/></svg>',
};
function toast(msg, kind) {
  const el = $('toast');
  el.innerHTML = `${TOAST_ICONS[kind] || TOAST_ICONS.info}<span>${escapeHtml(msg)}</span>`;
  el.className = 'show fixed bottom-5 left-1/2 -translate-x-1/2 z-50 max-w-xl flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium shadow-pop border bg-s3 text-ink ' +
    'border-line-strong';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 6000 : 3500);
}

// ------------------------------------------------------------------ modale
let modalResolve = null, modalReturnFocus = null;
function openModal(title, bodyHtml, actions) {
  closeModal(false);
  modalReturnFocus = document.activeElement;
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  $('modal-actions').innerHTML = actions.map((a, i) =>
    `<button data-i="${i}" class="btn ${a.danger ? 'btn-danger' : a.primary ? 'btn-primary' : 'btn-secondary'}">${escapeHtml(a.label)}</button>`).join('');
  $('modal').classList.remove('hidden');
  const btns = $('modal-actions').querySelectorAll('button');
  (btns[0] || $('modal')).focus();
  return new Promise((resolve) => {
    modalResolve = resolve;
    btns.forEach((b) => b.addEventListener('click', () => closeModal(actions[+b.dataset.i].value)));
  });
}
function closeModal(value) {
  if ($('modal').classList.contains('hidden')) return;
  $('modal').classList.add('hidden');
  const r = modalResolve; modalResolve = null;
  if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
  if (r) r(value);
}
const modalOpen = () => !$('modal').classList.contains('hidden');
$('modal').addEventListener('click', (ev) => { if (ev.target === $('modal')) closeModal(false); });

const SHORTCUTS = [
  [['Spazio'], 'Play / pausa'], [['↑', '↓'], 'Canale o film precedente / successivo'], [['0–9'], 'Vai al canale con quel numero'],
  [['⌫'], 'Torna all\'ultimo contenuto visto'],
  [['←', '→'], 'Indietro / avanti 10 s (film)'], [['+', '−'], 'Volume (anche rotella sul player)'], [['M'], 'Muto'],
  [['F'], 'Schermo intero'], [['T'], 'Modalità cinema'], [['P'], 'Picture in Picture'], [['R'], 'Ricarica stream'],
  [['/'], 'Cerca nella lista'], [['Esc'], 'Svuota la ricerca / chiudi'], [['?'], 'Mostra questo elenco'],
];
function showShortcuts() {
  const rows = SHORTCUTS.map(([keys, desc]) =>
    `<div class="flex items-center justify-between gap-4 py-1.5 border-b border-line last:border-0"><span>${escapeHtml(desc)}</span><span class="flex gap-1 shrink-0">${keys.map((k) => `<span class="kbd">${escapeHtml(k)}</span>`).join('')}</span></div>`).join('');
  openModal('Scorciatoie da tastiera', rows, [{ label: 'Chiudi', value: true, primary: true }]);
}
$('help-btn').addEventListener('click', showShortcuts);

const ICONS = {
  play: '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11.04-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14z"/></svg>',
  pause: '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  vol: '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
  mute: '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="m22 9-6 6M16 9l6 6"/></svg>',
  star: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>',
  starO: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>',
  eye: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.6 3.6M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20"/></svg>',
  list: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
  clock: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  eq: '<span class="eq" aria-label="In riproduzione"><i></i><i></i><i></i></span>',
};

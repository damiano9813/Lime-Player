// Playlist salvate, accesso, cambio di playlist, account e stato di ffmpeg.
'use strict';

// ------------------------------------------------------------------ login
// versioni precedenti: server e utente (e prima ancora la password) in localStorage, letti solo per la migrazione
const CREDS_KEY = 'xp.credentials';

let loginSeq = 0;
// playlist salvate { server, username, name, last }: le password le custodisce Rust nel vault
let accounts = [];
// form della nuova playlist aperto sopra l'elenco
let formOpen = false;

const accountLabel = (a) => (a && (a.name || a.username)) || '';
const sameAccount = (a, b) => !!a && !!b && a.server === b.server && a.username === b.username;
const TRASH = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>';

async function refreshAccounts() {
  try { accounts = await invoke('list_accounts'); } catch { accounts = []; }
  renderAccountPicker();
  renderAccountSwitch();
}

function setFormOpen(open) {
  formOpen = open;
  const list = accounts.length > 0;
  $('login-form').classList.toggle('hidden', list && !open);
  $('login-form-head').classList.toggle('hidden', !list);
  $('acct-add').classList.toggle('hidden', !list || open);
}

function renderAccountPicker() {
  $('acct-picker').classList.toggle('hidden', !accounts.length);
  $('acct-list').innerHTML = accounts.map((a, i) => `
    <div class="flex items-center gap-1 rounded-lg border border-line bg-s1 hover:bg-s3 transition">
      <button type="button" data-open="${i}" class="flex-1 min-w-0 text-left px-3 py-2 disabled:cursor-wait">
        <div class="text-sm font-bold text-ink truncate">${escapeHtml(accountLabel(a))}</div>
        <div class="text-[11px] text-ink-subtle truncate" title="${escapeHtml(a.server)}">${escapeHtml(a.name ? `${a.username} · ${a.server}` : a.server)}</div>
      </button>
      <button type="button" data-remove="${i}" class="icon-btn mr-1 shrink-0" title="Rimuovi playlist" aria-label="Rimuovi ${escapeHtml(accountLabel(a))}">${TRASH}</button>
    </div>`).join('');
  setFormOpen(formOpen);
}

// selettore nella barra laterale: le playlist salvate più quella aperta, se non è salvata
function renderAccountSwitch() {
  const sel = $('acct-switch');
  const list = S.creds && !accounts.some((a) => sameAccount(a, S.creds))
    ? [{ ...S.creds, name: S.acctName }, ...accounts] : accounts;
  sel.classList.toggle('hidden', !S.creds || list.length < 2);
  sel.innerHTML = list.map((a, i) =>
    `<option value="${i}" ${sameAccount(a, S.creds) ? 'selected' : ''}>${escapeHtml(accountLabel(a))}</option>`).join('');
  sel.onchange = () => {
    const a = list[+sel.value];
    if (a && !sameAccount(a, S.creds)) switchAccount(a);
  };
}

function setLoginBusy(busy, text) {
  $('login-btn').disabled = busy;
  $('login-spin').classList.toggle('hidden', !busy);
  $('login-btn-text').textContent = busy ? (text || 'Connessione…') : 'Accedi';
  $('login-cancel').classList.toggle('hidden', !busy);
  ['f-name', 'f-server', 'f-user', 'f-pass'].forEach((id) => { $(id).disabled = busy; });
  $('acct-list').querySelectorAll('button').forEach((b) => { b.disabled = busy; });
  $('acct-add').disabled = busy;
  // con il form chiuso l'avanzamento si vede sotto l'elenco
  const inList = busy && $('login-form').classList.contains('hidden');
  $('acct-busy').classList.toggle('hidden', !inList);
  $('acct-busy-text').textContent = inList ? (text || 'Connessione…') : '';
}
function showLoginError(msg) {
  const el = $('login-error');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}
function fillLoginForm(c) {
  if (!c) return;
  $('f-name').value = c.name || '';
  $('f-server').value = c.server || '';
  $('f-user').value = c.username || '';
  $('f-pass').value = c.password || '';
}
function clearLoginForm() {
  fillLoginForm({});
  $('f-remember').checked = true;
}

async function doLogin(creds, remember, auto) {
  const seq = ++loginSeq;
  showLoginError('');
  const label = accountLabel(creds);
  setLoginBusy(true, auto ? `Accesso automatico a ${label}…` : `Connessione a ${label}…`);
  try {
    const account = await invoke('xtream_login', { server: creds.server, username: creds.username, password: creds.password });
    if (seq !== loginSeq) return;
    const normalized = { server: account.normalized_server, username: creds.username.trim(), password: creds.password };
    const name = (creds.name || '').trim();
    const saved = accounts.find((a) => sameAccount(a, normalized));
    S.creds = normalized;
    S.acctName = name || (saved && saved.name) || '';
    S.account = account;
    if (remember) {
      invoke('save_credentials', { ...normalized, name })
        .catch((e) => toast('Playlist non salvata: ' + errText(e), 'error'))
        .finally(refreshAccounts);
    }
    setFormOpen(false);
    clearLoginForm();
    enterApp();
  } catch (e) {
    if (seq !== loginSeq) return;
    fillLoginForm(creds);
    setFormOpen(true);
    showLoginError(errText(e));
  } finally {
    if (seq === loginSeq) setLoginBusy(false);
  }
}

// accesso con una playlist salvata: la password arriva dal vault
async function openSavedAccount(a) {
  let c = null;
  try { c = await invoke('load_account', { server: a.server, username: a.username }); } catch (e) { toast(errText(e), 'error'); }
  if (!c) {
    fillLoginForm({ ...a, password: '' });
    setFormOpen(true);
    showLoginError('Password non trovata su questo PC: inseriscila di nuovo.');
    $('f-pass').focus();
    return;
  }
  await doLogin(c, true, false);
}

async function removeSavedAccount(a) {
  const ok = await openModal(`Rimuovere ${accountLabel(a)}?`,
    '<p>La password salvata su questo PC e le liste scaricate di questa playlist verranno cancellate. Preferiti e cronologia tornano se la aggiungi di nuovo.</p>',
    [{ label: 'Annulla', value: false }, { label: 'Rimuovi', value: true, danger: true }]);
  if (!ok) return;
  try {
    await invoke('remove_account', { server: a.server, username: a.username });
    await invoke('clear_account_cache', { server: a.server, username: a.username }).catch(() => {});
    toast(`Playlist ${accountLabel(a)} rimossa`, 'ok');
  } catch (e) { toast(errText(e), 'error'); }
  await refreshAccounts();
  if (!accounts.length) $('f-server').focus();
}

$('acct-list').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b || b.disabled) return;
  if (b.dataset.open != null) openSavedAccount(accounts[+b.dataset.open]);
  else if (b.dataset.remove != null) removeSavedAccount(accounts[+b.dataset.remove]);
});
$('acct-add').addEventListener('click', () => {
  clearLoginForm();
  showLoginError('');
  setFormOpen(true);
  $('f-name').focus();
});
$('login-form-close').addEventListener('click', () => {
  showLoginError('');
  setFormOpen(false);
});
// la richiesta in corso non si può interrompere: se ne ignora il risultato
function cancelLogin() {
  loginSeq += 1;
  setLoginBusy(false);
  if (!$('login-form').classList.contains('hidden')) $('f-server').focus();
}
$('login-cancel').addEventListener('click', cancelLogin);
$('acct-cancel').addEventListener('click', cancelLogin);

$('login-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const creds = { name: $('f-name').value.trim(), server: $('f-server').value.trim(), username: $('f-user').value.trim(), password: $('f-pass').value };
  if (!creds.server || !creds.username || !creds.password) { showLoginError('Compila URL server, username e password.'); return; }
  doLogin(creds, $('f-remember').checked);
});
function updatePassToggle() {
  const shown = $('f-pass').type === 'text';
  const b = $('toggle-pass');
  b.innerHTML = shown ? ICONS.eyeOff : ICONS.eye;
  b.title = shown ? 'Nascondi password' : 'Mostra password';
  b.setAttribute('aria-label', b.title);
  b.setAttribute('aria-pressed', String(shown));
}
$('toggle-pass').addEventListener('click', () => {
  const p = $('f-pass');
  p.type = p.type === 'password' ? 'text' : 'password';
  updatePassToggle();
});

// chiude la playlist aperta e torna all'elenco; preferiti, recenti e posizioni restano salvati
// sotto l'account e tornano al prossimo accesso
function leaveAccount() {
  loginSeq += 1;
  destroyPlayer();
  resetPlayerUi();
  S.loadSeq += 1;
  S.listAge.clear();
  S.previous = null;
  S.creds = null; S.account = null; S.acctName = ''; S.cache.clear();
  // gli id di canali e film valgono solo per il loro provider
  EPG.cache.clear(); EPG.inflight.clear(); EPG.queue = [];
  VODINFO.clear();
  unloadAccountData();
  S.categories = perMode(() => null);
  S.catNames = perMode(() => new Map());
  S.liveReady = false;
  closeGuide();
  resetBrowse();
  resetGuide();
  S.list = []; S.filtered = [];
  $('acct-switch').classList.add('hidden');
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
}

function switchAccount(a) {
  leaveAccount();
  showLoginError('');
  setFormOpen(false);
  openSavedAccount(a);
}

$('logout-btn').addEventListener('click', async () => {
  leaveAccount();
  // al prossimo avvio si sceglie dall'elenco
  await invoke('clear_last_account').catch(() => {});
  await refreshAccounts();
  showLoginError('');
  setFormOpen(!accounts.length);
  if (!accounts.length) $('f-server').focus();
});

function enterApp() {
  loadAccountData();
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  renderAccount();
  renderAccountSwitch();
  renderCaps();
  setTheater(lsGet('xp.theater', false));
  // all'accesso la Home; la Live TV carica i canali alla prima apertura
  setView('home');
  renderListsAge();
  // aggiornamento giornaliero delle liste: dopo il primo caricamento, per non rallentare l'avvio
  const acct = S.acct;
  setTimeout(() => { if (S.acct === acct) maybeRefreshLists(); }, 8000);
}

function renderAccount() {
  const a = S.account;
  $('acct-avatar').textContent = initials(S.acctName || (a && a.username));
  if (!a) { $('account-box').innerHTML = ''; return; }
  let exp = 'Illimitata', expCls = 'text-ink', daysLeft = Infinity;
  const ts = parseInt(a.exp_date, 10);
  if (ts > 0) {
    exp = new Date(ts * 1000).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
    daysLeft = Math.ceil((ts * 1000 - Date.now()) / 86400000);
    if (daysLeft <= 0) { exp += ' (scaduto)'; expCls = 'text-danger'; }
    else if (daysLeft <= 7) { exp += ` (tra ${daysLeft} g)`; expCls = 'text-accent-ink'; }
  }
  const status = a.status || 'Sconosciuto';
  const ok = /active/i.test(status);
  $('account-box').innerHTML = `
    <div class="flex items-center justify-between gap-2"><span class="text-ink font-bold truncate" title="${escapeHtml(a.username)}">${escapeHtml(S.acctName || a.username)}</span>
      <span class="badge ${ok ? 'bg-success-soft text-success' : 'bg-accent-soft text-accent-ink'}">${escapeHtml(status)}</span></div>
    <div class="flex justify-between"><span>Scadenza</span><span class="${expCls}">${escapeHtml(exp)}</span></div>
    <div class="flex justify-between"><span>Connessioni</span><span class="text-ink tabular-nums">${escapeHtml(a.active_cons || '0')} / ${escapeHtml(a.max_connections || '?')}</span></div>
    <div class="truncate text-ink-subtle" title="${escapeHtml(a.normalized_server)}">${escapeHtml(a.normalized_server)}</div>`;
  if (!ok) toast(`Stato account: ${status}`, 'error');
  else if (daysLeft <= 7) toast(daysLeft <= 0 ? 'L\'abbonamento risulta scaduto' : `L'abbonamento scade tra ${daysLeft} giorn${daysLeft === 1 ? 'o' : 'i'}`, 'error');
}

function renderCaps() {
  const c = S.caps || {};
  const el = $('caps-box');
  // su Android il motore è ExoPlayer: ffmpeg esterno non serve
  if (PLATFORM.android) { el.classList.add('hidden'); return; }
  if (c.ffmpeg) {
    el.textContent = `Codec extra: ffmpeg attivo · video ${c.h264_encoder || 'software'}`;
    el.title = `${c.version || 'ffmpeg'}\n${c.ffmpeg}`;
    el.className = 'text-[11px] text-success mb-2 truncate';
  } else {
    el.textContent = 'Codec extra: ffmpeg non trovato (AC3/DTS/HEVC/MPEG-2 non convertibili)';
    el.title = 'ffmpeg è incluso nell\'installer: reinstalla l\'app, oppure installalo con winget install Gyan.FFmpeg e riavvia';
    el.className = 'text-[11px] text-accent-ink mb-2 truncate';
  }
}

// Login, logout, account e stato di ffmpeg.
'use strict';

// ------------------------------------------------------------------ login
// solo server e utente (precompilano il form); la password la custodisce Rust nel vault
const CREDS_KEY = 'xp.credentials';

let loginSeq = 0;

function setLoginBusy(busy, text) {
  $('login-btn').disabled = busy;
  $('login-spin').classList.toggle('hidden', !busy);
  $('login-btn-text').textContent = busy ? (text || 'Connessione…') : 'Accedi';
  $('login-cancel').classList.toggle('hidden', !busy);
  ['f-server', 'f-user', 'f-pass'].forEach((id) => { $(id).disabled = busy; });
}
function showLoginError(msg) {
  const el = $('login-error');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}
function fillLoginForm(c) {
  if (!c) return;
  $('f-server').value = c.server || '';
  $('f-user').value = c.username || '';
  $('f-pass').value = c.password || '';
}

async function doLogin(creds, remember, auto) {
  const seq = ++loginSeq;
  showLoginError('');
  setLoginBusy(true, auto ? `Accesso automatico come ${creds.username}…` : 'Connessione al server…');
  try {
    const account = await invoke('xtream_login', { server: creds.server, username: creds.username, password: creds.password });
    if (seq !== loginSeq) return;
    const normalized = { server: account.normalized_server, username: creds.username.trim(), password: creds.password };
    S.creds = normalized;
    S.account = account;
    if (remember) {
      lsSet(CREDS_KEY, XPCore.publicCreds(normalized));
      invoke('save_credentials', normalized).catch((e) => toast('Credenziali non salvate: ' + errText(e), 'error'));
    }
    enterApp();
  } catch (e) {
    if (seq !== loginSeq) return;
    showLoginError(errText(e));
    fillLoginForm(creds);
  } finally {
    if (seq === loginSeq) setLoginBusy(false);
  }
}

// la richiesta in corso non si può interrompere: se ne ignora il risultato
$('login-cancel').addEventListener('click', () => {
  loginSeq += 1;
  setLoginBusy(false);
  $('f-server').focus();
});

$('login-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const creds = { server: $('f-server').value.trim(), username: $('f-user').value.trim(), password: $('f-pass').value };
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

async function logout() {
  destroyPlayer();
  resetPlayerUi();
  lsDel(CREDS_KEY);
  await invoke('clear_credentials').catch(() => {});
  // le liste salvate appartengono all'account: si cancellano con le credenziali
  await invoke('clear_list_cache').catch(() => {});
  S.listAge.clear();
  S.previous = null;
  S.creds = null; S.account = null; S.cache.clear();
  // preferiti, recenti e posizioni restano salvati sotto l'account e tornano al prossimo accesso
  unloadAccountData();
  S.categories = perMode(() => null);
  S.catNames = perMode(() => new Map());
  closeSeries();
  S.list = []; S.filtered = [];
  $('f-pass').value = '';
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
}
$('logout-btn').addEventListener('click', async () => {
  const ok = await openModal('Uscire dall\'account?',
    '<p>Lo stream in corso verrà fermato e le credenziali salvate su questo PC verranno cancellate. Preferiti e cronologia restano disponibili.</p>',
    [{ label: 'Annulla', value: false }, { label: 'Esci', value: true, danger: true }]);
  if (ok) logout();
});

function enterApp() {
  loadAccountData();
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  renderAccount();
  renderCaps();
  setTheater(lsGet('xp.theater', false));
  switchMode(S.mode, true);
}

function renderAccount() {
  const a = S.account;
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
    <div class="flex items-center justify-between"><span class="text-ink font-bold truncate">${escapeHtml(a.username)}</span>
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

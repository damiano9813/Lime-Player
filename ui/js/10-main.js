// Tastiera e avvio.
'use strict';

// ------------------------------------------------------------------ tastiera
// zapping per numero come su un televisore: le cifre si accumulano per 1,2 s (Invio conferma subito)
const Z = { digits: '', timer: null };
function zapCommit() {
  clearTimeout(Z.timer); Z.timer = null;
  const n = Z.digits; Z.digits = '';
  if (!n) return;
  const match = (it) => String(it.num) === n;
  let idx = S.filtered.findIndex(match);
  if (idx === -1 && S.search) { clearSearch(); idx = S.filtered.findIndex(match); }
  if (idx === -1) { toast(`Nessun canale con il numero ${n} in questa lista`, 'error'); return; }
  scrollToIndex(idx);
  playItem(S.filtered[idx], S.mode);
}
function zapDigit(d) {
  Z.digits = (Z.digits + d).slice(-5);
  osd(`<span class="text-2xl">${escapeHtml(Z.digits)}</span><span class="text-ink-muted animate-pulse">_</span>`);
  clearTimeout(Z.timer);
  Z.timer = setTimeout(zapCommit, 1200);
}

// Esc risale un livello alla volta: menu, scheda, ricerca o griglia, player a tutta finestra,
// modalità cinema. Nelle righe frecce, pagine, Invio e Spazio scorrono e attivano le schede.
function onTypingKey(ev) {
  const id = ev.target.id;
  if (ev.key === 'Escape') {
    // prima Esc svuota la ricerca, la seconda toglie il focus
    if (id === 'stream-search' && S.search) clearSearch();
    else if (id === 'cat-search' && S.catFilter) { ev.target.value = ''; S.catFilter = ''; renderCategories(); }
    else if (id === 'gsearch-input' && ev.target.value) clearGlobalSearch(true);
    else ev.target.blur();
  }
  if (id === 'stream-search' && (ev.key === 'ArrowDown' || ev.key === 'Enter')) {
    ev.preventDefault(); ev.target.blur();
    if (S.filtered.length) {
      if (ev.key === 'Enter') { scrollToIndex(0); activateItem(S.filtered[0]); } else if (S.mode !== 'series') stepChannel(1);
    }
  }
  // dalla ricerca in alto al primo risultato
  if (id === 'gsearch-input' && (ev.key === 'ArrowDown' || ev.key === 'Enter') && B.search) {
    const first = browsePage.querySelector('.pcard-btn');
    if (first) { ev.preventDefault(); first.focus(); }
  }
}

// pagina a righe (Home, Film, Serie, griglia, ricerca): true se il tasto è gestito qui
function onBrowseKey(ev) {
  switch (ev.key) {
    case 'Escape':
      if (B.search) clearGlobalSearch(true);
      else if (B.grid) closeGrid();
      else return true;
      ev.preventDefault();
      return true;
    case '/': ev.preventDefault(); gsearch.focus(); gsearch.select(); return true;
    case 'h': case 'H': ev.preventDefault(); setView('home'); return true;
    case '?': ev.preventDefault(); showShortcuts(); return true;
    // un canale che continua in sottofondo: muto e volume restano a portata
    case 'm': case 'M': case '+': case '=': case '-': case '_': return !S.current;
    default: return true;
  }
}

document.addEventListener('keydown', (ev) => {
  if ($('app-view').classList.contains('hidden')) return;
  if (modalOpen()) { if (ev.key === 'Escape') { ev.preventDefault(); closeModal(false); } return; }
  if (settingsPanelOpen()) { if (ev.key === 'Escape') { ev.preventDefault(); closeSettings(); } return; }
  if (ev.key === 'Escape' && acctMenuOpen()) { ev.preventDefault(); closeAcctMenu(); $('acct-btn').focus(); return; }
  const tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { onTypingKey(ev); return; }
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
  const full = playerFull();
  // scheda aperta (e non coperta dal player): Esc la chiude, il resto la scorre e ne attiva i pulsanti
  if (detailOpen() && !full) {
    if (ev.key === 'Escape') { ev.preventDefault(); closeDetail(); }
    return;
  }
  if (!full && browseVisible() && onBrowseKey(ev)) return;
  if (!full && guideOpen()) {
    if (ev.key === 'Escape' || ev.key === 'g' || ev.key === 'G') { ev.preventDefault(); closeGuide(); return; }
    // frecce e pagine scorrono la griglia; i comandi del player la chiudono prima
    if (/^(Arrow|Page|Home$|End$)/.test(ev.key)) return;
    if (/^[fFtTpP/0-9]$/.test(ev.key)) closeGuide();
  }
  if (/^[0-9]$/.test(ev.key) && !full && S.view === 'live') { ev.preventDefault(); zapDigit(ev.key); return; }
  if (ev.key === 'Enter' && Z.digits) { ev.preventDefault(); zapCommit(); return; }
  switch (ev.key) {
    case ' ': case 'k': ev.preventDefault(); togglePlay(); break;
    case 'f': case 'F': ev.preventDefault(); toggleFullscreen(); break;
    case 'm': case 'M': ev.preventDefault(); $('btn-mute').click(); osd((video.muted ? ICONS.mute : ICONS.vol).replace('w-5 h-5', 'w-6 h-6')); break;
    case 't': case 'T': if (!full) { ev.preventDefault(); setTheater(!theaterOn()); } break;
    case 'p': case 'P': ev.preventDefault(); togglePip(); break;
    case 'r': case 'R': if (S.current) { ev.preventDefault(); playItem(S.current, S.currentMode); } break;
    case '+': case '=': ev.preventDefault(); changeVolume(0.05); break;
    case '-': case '_': ev.preventDefault(); changeVolume(-0.05); break;
    case 'n': case 'N': if (full && S.current && S.current._kind === 'episode') { ev.preventDefault(); stepEpisode(1); } break;
    case 'Backspace':
      // come il tasto "indietro" del telecomando: alterna tra gli ultimi due contenuti
      if (S.previous) { ev.preventDefault(); const p = S.previous; playItem(p.item, p.mode); locateCurrent(false); }
      break;
    // a tutta finestra ↑/↓ regolano il volume, nella Live TV cambiano canale
    case 'ArrowDown': ev.preventDefault(); if (full) changeVolume(-0.05); else stepChannel(1); break;
    case 'ArrowUp': ev.preventDefault(); if (full) changeVolume(0.05); else stepChannel(-1); break;
    case 'ArrowRight': if (S.currentMode === 'vod') { ev.preventDefault(); seekBy(10); } break;
    case 'ArrowLeft': if (S.currentMode === 'vod') { ev.preventDefault(); seekBy(-10); } break;
    case '/':
      ev.preventDefault();
      if (full) break;
      if (theaterOn()) setTheater(false);
      $('stream-search').focus(); $('stream-search').select();
      break;
    case '?': ev.preventDefault(); showShortcuts(); break;
    case 'g': case 'G': if (!full && S.view === 'live') { ev.preventDefault(); openGuide(); } break;
    case 'h': case 'H': if (!full) { ev.preventDefault(); setView('home'); } break;
    case 'Escape':
      if (tracksMenuOpen()) closeTracksMenu();
      else if (wrap.classList.contains('fs-fake')) exitFullscreen();
      else if (full && !fsElement()) closePlayer();
      else if (theaterOn() && !fsElement()) setTheater(false);
      break;
    default: break;
  }
});

// ------------------------------------------------------------------ aggiornamenti
// controllo all'avvio sull'ultima release GitHub (latest.json firmato, vedi updater.rs)
let pendingUpdate = null;

function showUpdate(u) {
  pendingUpdate = u;
  const b = $('update-box');
  b.textContent = `Nuova versione ${u.version} disponibile`;
  b.title = `Versione installata: ${u.current}`;
  b.classList.remove('hidden');
  // il pulsante sta nel menu dell'account: un punto sull'avatar lo segnala
  $('update-dot').classList.remove('hidden');
}

async function checkUpdate(manual) {
  const btn = $('set-update');
  if (manual) { btn.disabled = true; btn.textContent = 'Controllo…'; }
  try {
    const u = await invoke('check_update');
    if (u) {
      showUpdate(u);
      if (manual) offerUpdate(); else toast(`Nuova versione disponibile: ${u.version}`, 'info');
    } else if (manual) toast('Hai già l\'ultima versione', 'ok');
  } catch (e) {
    // all'avvio un controllo fallito (offline, nessuna release) non disturba
    if (manual) toast('Controllo aggiornamenti non riuscito: ' + errText(e), 'error');
  } finally {
    if (manual) { btn.disabled = false; btn.textContent = 'Cerca aggiornamenti'; }
  }
}

async function offerUpdate() {
  const u = pendingUpdate;
  if (!u) return;
  const notes = u.notes ? `<pre class="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-ink-muted bg-s1 border border-line rounded-lg p-3">${escapeHtml(u.notes)}</pre>` : '';
  const ok = await openModal(`Nuova versione ${u.version}`,
    `<p>Versione installata: ${escapeHtml(u.current)}. L'aggiornamento ferma lo stream, scarica l'installer e riavvia l'app.</p>${notes}`,
    [{ label: 'Più tardi', value: false }, { label: 'Aggiorna ora', value: true, primary: true }]);
  if (!ok) return;
  destroyPlayer();
  resetPlayerUi();
  const b = $('update-box');
  b.disabled = true;
  b.textContent = 'Download dell\'aggiornamento…';
  try {
    await invoke('install_update');
  } catch (e) {
    toast(errText(e), 'error');
    b.disabled = false;
    showUpdate(u);
  }
}

$('update-box').addEventListener('click', offerUpdate);
$('set-update').addEventListener('click', () => checkUpdate(true));

// ------------------------------------------------------------------ avvio
async function init() {
  updateNav();
  updatePlayButton();
  updatePassToggle();
  updateFavButton();
  const vol = lsGet('xp.volume', null);
  if (vol && typeof vol.v === 'number') { video.volume = Math.min(1, Math.max(0, vol.v)); video.muted = !!vol.m; }
  updateVolumeUi();
  setRangeFill(seek);

  if (!TAURI || !TAURI.core) {
    showLoginError('API Tauri non disponibile: questa pagina va aperta dall\'app desktop (cargo tauri dev).');
    return;
  }
  // Android/TV: viewport, telecomando e tasto Indietro prima di disegnare il resto
  await initAndroid();
  if (!PLATFORM.android) invoke('platform_info').then((p) => { PLATFORM.device = p.device || ''; }).catch(() => {});
  if (!window.mpegts || !window.Hls) {
    toast('Librerie video mancanti: esegui "npm run build:ui" nella cartella del progetto.', 'error');
  }
  try { S.proxy = await invoke('get_proxy_info'); } catch (e) { toast('Proxy locale non disponibile: ' + errText(e), 'error'); }
  // motore mpv: prima del login, così il primo canale parte già nel motore giusto
  await initMpv();
  // la rilevazione di ffmpeg/encoder prova davvero la GPU: non blocca il login
  invoke('get_media_capabilities').then((c) => { S.caps = c; renderCaps(); }).catch(() => { renderCaps(); });
  if (TAURI.app && TAURI.app.getVersion) TAURI.app.getVersion().then((v) => { $('set-version').textContent = `Versione installata: ${v}`; }).catch(() => {});
  checkUpdate(false);
  // liste salvate su disco riscaricate in background dal backend
  if (TAURI.event) TAURI.event.listen('list-updated', (e) => onListUpdated(e.payload)).catch(() => {});

  // le versioni precedenti tenevano anche la password in localStorage: passa al vault e sparisce
  const local = lsGet(CREDS_KEY, null);
  let saved = null;
  try { saved = await invoke('load_credentials'); } catch { saved = null; }
  if (local && local.password && !saved) {
    saved = local;
    await invoke('save_credentials', { server: local.server, username: local.username, password: local.password }).catch(() => {});
  }
  lsDel(CREDS_KEY);
  // playlist arrivate da altri dispositivi prima dell'elenco (al massimo qualche secondo)
  await initSync();
  await refreshAccounts();
  // accesso automatico all'ultima playlist usata; senza, l'elenco delle playlist (o il form se è vuoto)
  if (saved && saved.server && saved.username && saved.password) {
    setFormOpen(false);
    await doLogin(saved, true, true);
  } else if (!accounts.length) {
    setFormOpen(true);
    fillLoginForm(XPCore.publicCreds(local));
    $(local && local.username ? 'f-pass' : 'f-server').focus();
  }
}

init();

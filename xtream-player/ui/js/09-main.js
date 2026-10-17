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

document.addEventListener('keydown', (ev) => {
  if ($('app-view').classList.contains('hidden')) return;
  if (modalOpen()) { if (ev.key === 'Escape') { ev.preventDefault(); closeModal(false); } return; }
  const tag = (ev.target && ev.target.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (typing) {
    if (ev.key === 'Escape') {
      // prima Esc svuota la ricerca, la seconda toglie il focus
      if (ev.target.id === 'stream-search' && S.search) clearSearch();
      else if (ev.target.id === 'cat-search' && S.catFilter) { ev.target.value = ''; S.catFilter = ''; renderCategories(); }
      else ev.target.blur();
    }
    if (ev.target.id === 'stream-search' && (ev.key === 'ArrowDown' || ev.key === 'Enter')) {
      ev.preventDefault(); ev.target.blur();
      if (S.filtered.length) {
        if (ev.key === 'Enter') { scrollToIndex(0); activateItem(S.filtered[0]); } else if (S.mode !== 'series') stepChannel(1);
      }
    }
    return;
  }
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
  if (/^[0-9]$/.test(ev.key) && S.mode === 'live') { ev.preventDefault(); zapDigit(ev.key); return; }
  if (ev.key === 'Enter' && Z.digits) { ev.preventDefault(); zapCommit(); return; }
  switch (ev.key) {
    case ' ': case 'k': ev.preventDefault(); togglePlay(); break;
    case 'f': case 'F': ev.preventDefault(); toggleFullscreen(); break;
    case 'm': case 'M': ev.preventDefault(); $('btn-mute').click(); osd((video.muted ? ICONS.mute : ICONS.vol).replace('w-5 h-5', 'w-6 h-6')); break;
    case 't': case 'T': ev.preventDefault(); setTheater(!theaterOn()); break;
    case 'p': case 'P': ev.preventDefault(); togglePip(); break;
    case 'r': case 'R': if (S.current) { ev.preventDefault(); playItem(S.current, S.currentMode); } break;
    case '+': case '=': ev.preventDefault(); changeVolume(0.05); break;
    case '-': case '_': ev.preventDefault(); changeVolume(-0.05); break;
    case 'Backspace':
      // come il tasto "indietro" del telecomando: alterna tra gli ultimi due contenuti
      if (S.previous) { ev.preventDefault(); const p = S.previous; playItem(p.item, p.mode); locateCurrent(false); }
      break;
    case 'ArrowDown': ev.preventDefault(); stepChannel(1); break;
    case 'ArrowUp': ev.preventDefault(); stepChannel(-1); break;
    case 'ArrowRight': if (S.currentMode === 'vod') { ev.preventDefault(); seekBy(10); } break;
    case 'ArrowLeft': if (S.currentMode === 'vod') { ev.preventDefault(); seekBy(-10); } break;
    case '/': ev.preventDefault(); if (theaterOn()) setTheater(false); closeSeries(); $('stream-search').focus(); $('stream-search').select(); break;
    case '?': ev.preventDefault(); showShortcuts(); break;
    case 'Escape':
      if (settingsOpen()) closeSettings();
      else if (S.seriesView && !theaterOn()) closeSeries();
      else if (theaterOn() && !document.fullscreenElement) setTheater(false);
      break;
    default: break;
  }
});

// ------------------------------------------------------------------ avvio
async function init() {
  updateModeButtons();
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
  if (!window.mpegts || !window.Hls) {
    toast('Librerie video mancanti: esegui "npm run build:ui" nella cartella xtream-player.', 'error');
  }
  try { S.proxy = await invoke('get_proxy_info'); } catch (e) { toast('Proxy locale non disponibile: ' + errText(e), 'error'); }
  // la rilevazione di ffmpeg/encoder prova davvero la GPU: non blocca il login
  invoke('get_media_capabilities').then((c) => { S.caps = c; renderCaps(); }).catch(() => { renderCaps(); });
  // liste salvate su disco riscaricate in background dal backend
  if (TAURI.event) TAURI.event.listen('list-updated', (e) => onListUpdated(e.payload)).catch(() => {});

  let saved = lsGet(CREDS_KEY, null);
  if (!saved || !saved.server) {
    try { saved = await invoke('load_credentials'); } catch { saved = null; }
    if (saved && saved.server) lsSet(CREDS_KEY, saved);
  }
  if (saved && saved.server && saved.username && saved.password) {
    fillLoginForm(saved);
    await doLogin(saved, true, true);
  } else {
    $('f-server').focus();
  }
}

init();

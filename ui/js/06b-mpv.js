// Motore mpv: libmpv disegna il video in una finestra nativa sotto la pagina (src-tauri/src/mpv.rs).
// La pagina diventa trasparente sul rettangolo del player e i controlli HTML restano sopra.
'use strict';

// ------------------------------------------------------------------ stato
const M = {
  available: false,
  // file caricato in mpv: la finestra del video è visibile e la pagina ha il "buco"
  loaded: false,
  paused: false,
  buffering: false,
  time: 0,
  duration: NaN,
  cache: 0,
  aid: 0,
  sid: 0,
  tech: {},
  lastResumeSave: 0,
  rectRaf: 0,
};
// motore scelto nelle impostazioni, se la DLL c'è
// nome del motore integrato per le etichette: mpv su Windows, ExoPlayer su Android
const ENGINE_NAME = PLATFORM.android ? 'ExoPlayer' : 'mpv';
const useMpv = () => M.available && S.settings.engine !== 'web';
// il contenuto in corso è riprodotto da mpv
const mpvActive = () => M.loaded && !!S.current;

// ------------------------------------------------------------------ rettangolo del video
// 07-controls.js definisce `wrap` dopo questo file: qui serve un riferimento proprio
const playerWrap = $('player-wrap');
const backdrop = $('mpv-backdrop');

function syncMpvRect() {
  cancelAnimationFrame(M.rectRaf);
  M.rectRaf = requestAnimationFrame(() => {
    const show = M.loaded && !$('app-view').classList.contains('hidden');
    const full = fsElement() === playerWrap;
    document.documentElement.classList.toggle('engine-mpv', show);
    // a schermo intero il player è trasparente: il resto della pagina, che il browser lascia
    // sotto, traspare sopra il video se non lo si nasconde
    document.documentElement.classList.toggle('mpv-full', show && full);
    playerWrap.classList.toggle('mpv-on', show);
    if (!show) { invoke('mpv_set_rect', { x: 0, y: 0, w: 0, h: 0, visible: false }).catch(() => {}); return; }
    const r = playerWrap.getBoundingClientRect();
    backdrop.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border-radius:${full || playerFull() ? 0 : 12}px`;
    // Android: px CSS e larghezza della pagina, la conversione la fa il plugin (pagina scalata)
    if (PLATFORM.android) { invoke('mpv_set_rect', { x: r.left, y: r.top, w: r.width, h: r.height, visible: true, vw: window.innerWidth }).catch(() => {}); return; }
    const k = window.devicePixelRatio || 1;
    invoke('mpv_set_rect', { x: r.left * k, y: r.top * k, w: r.width * k, h: r.height * k, visible: true }).catch(() => {});
  });
}
new ResizeObserver(syncMpvRect).observe(playerWrap);
window.addEventListener('resize', syncMpvRect);
// la finestra cambia misura in più passaggi dopo l'evento: si rimisura anche a transizione finita
document.addEventListener('fullscreenchange', () => {
  syncMpvRect();
  setTimeout(syncMpvRect, 150);
  setTimeout(syncMpvRect, 500);
});
$('live-scroller').addEventListener('scroll', syncMpvRect, { passive: true });
// modalità cinema e cambio di vista spostano il player senza ridimensionarlo (il passaggio a tutta
// finestra lo segnala mountPlayer)
new MutationObserver(syncMpvRect).observe($('app-view'), { attributes: true, attributeFilter: ['class'] });

// ------------------------------------------------------------------ avvio e arresto
function mpvStop() {
  if (!M.loaded) return;
  M.loaded = false;
  M.paused = false; M.buffering = false; M.time = 0; M.duration = NaN; M.cache = 0; M.tech = {};
  invoke('mpv_stop').catch(() => {});
  syncMpvRect();
}

function startMpv(item, mode, opts) {
  const live = mode === 'live';
  const hls = live && (opts.fmt || S.liveFormat) === 'm3u8';
  const url = live ? buildStreamUrl(item, 'live', hls ? 'm3u8' : 'ts') : (item._url || buildStreamUrl(item, 'vod'));
  S.currentUrl = url;
  P.fmt = hls ? 'm3u8' : 'ts';
  P.tracks.from = 'mpv';
  renderTracksMenu();
  let start = 0;
  if (!live) {
    const saved = getResume(resumeKey(item));
    start = opts.ss != null ? opts.ss : (saved > 30 ? saved : 0);
    if (item._duration > 0) P.vodDuration = item._duration;
    // durata dalla scheda del film, prima che mpv la legga dal file
    if (!item._kind && !item._catchup) {
      vodInfoFor(item).then((info) => {
        if (S.current === item && !isFinite(M.duration) && info && info.meta.duration_secs > 0) { M.duration = info.meta.duration_secs; updateTimeUi(); }
      });
    }
  }
  M.loaded = true;
  M.paused = false; M.buffering = true; M.time = start; M.duration = isFinite(P.vodDuration) ? P.vodDuration : NaN; M.cache = 0; M.tech = {};
  syncMpvRect();
  setStatus(live ? 'Connessione allo stream…' : 'Caricamento…');
  if (start > 0) toast(`Ripresa da ${fmtTime(start)}`);
  updateTech();
  invoke('mpv_load', {
    url, live, start: start || null,
    cacheSecs: live ? XPCore.mpvCacheSecs(L.mode) : null,
    alang: S.settings.audioLang, slang: live ? '' : S.settings.subLang, audio: S.settings.audioOut,
    volume: Math.round(video.volume * 100), mute: video.muted, title: item.name || '',
  }).catch((e) => {
    if (S.current !== item) return;
    if (live) onLiveError(errText(e));
    else { mpvStop(); showError('Impossibile avviare mpv: ' + errText(e)); }
  });
}

// ------------------------------------------------------------------ comandi dei controlli
const mpvSet = (name, value) => invoke('mpv_set', { name, value: String(value) }).catch((e) => toast(errText(e), 'error'));
function mpvTogglePause() {
  M.paused = !M.paused;
  mpvSet('pause', M.paused ? 'yes' : 'no');
  osd((M.paused ? ICONS.pause : ICONS.play).replace('w-5 h-5', 'w-8 h-8'));
  updatePlayButton();
  if (M.paused) { setStatus('In pausa'); playerWrap.classList.remove('idle'); }
}
function mpvSeek(t) {
  M.time = t;
  setSpinner(true);
  invoke('mpv_seek', { secs: t }).catch((e) => toast(errText(e), 'error'));
  updateTimeUi();
}
function mpvSetAudio(track) {
  mpvSet('aid', track.index);
  M.aid = track.index;
  toast(`Audio: ${XPCore.trackLabel(track)}`);
  renderTracksMenu();
}
function mpvSetSub(idx) {
  const t = idx >= 0 ? P.tracks.subs[idx] : null;
  P.subIndex = t ? idx : -1;
  mpvSet('sid', t ? t.index : 'no');
  toast(t ? `Sottotitoli: ${XPCore.trackLabel(t)}` : 'Sottotitoli disattivati');
  renderTracksMenu();
}
// il volume resta sul tag video (nascosto): controlli, tasti e salvataggio non cambiano
video.addEventListener('volumechange', () => {
  if (!M.loaded) return;
  mpvSet('volume', Math.round(video.volume * 100));
  mpvSet('mute', video.muted ? 'yes' : 'no');
});

function mpvTech() {
  const t = M.tech, bits = [];
  bits.push(S.currentMode === 'live' ? (P.fmt === 'm3u8' ? `HLS (${ENGINE_NAME})` : `MPEG-TS (${ENGINE_NAME})`) : `${(S.current.container_extension || 'mp4').toUpperCase()} (${ENGINE_NAME})`);
  if (t.width && t.height) bits.push(`${t.width}×${t.height}`);
  if (t.vcodec) bits.push(t.vcodec);
  if (t.acodec) bits.push(t.acodec + (t.channels ? ` ${XPCore.channelsLabel(t.channels)}` : ''));
  if (t.hwdec && t.hwdec !== 'no') bits.push(`decodifica hardware (${t.hwdec})`);
  return bits.join(' · ');
}

// ------------------------------------------------------------------ eventi di mpv
const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : NaN; };

function onMpvEvent(e) {
  if (!M.loaded || !e) return;
  const v = e.value;
  switch (e.name) {
    case 'playback-restart':
      M.buffering = false;
      setSpinner(false);
      hideError();
      P.hadPlaying = true;
      setStatus(M.paused ? 'In pausa' : (S.currentMode === 'live' ? 'In onda' : 'In riproduzione'));
      updatePlayButton();
      updateTech();
      break;
    case 'paused-for-cache':
      M.buffering = v === 'yes';
      setSpinner(M.buffering);
      if (M.buffering) setStatus('Buffering…');
      else if (P.hadPlaying) setStatus(S.currentMode === 'live' ? 'In onda' : 'In riproduzione');
      break;
    case 'pause':
      M.paused = v === 'yes';
      updatePlayButton();
      break;
    case 'time-pos': {
      const t = num(v);
      if (!isFinite(t)) break;
      M.time = t;
      updateTimeUi();
      if (S.currentMode === 'vod' && t > 0 && Date.now() - M.lastResumeSave > 5000) {
        const rk = resumeKey(S.current);
        if (rk) { M.lastResumeSave = Date.now(); setResume(rk, Math.floor(t), M.duration); }
      }
      break;
    }
    case 'duration': { const d = num(v); if (d > 0) { M.duration = d; updateTimeUi(); } break; }
    case 'demuxer-cache-duration': M.cache = num(v) || 0; updateMpvCacheUi(); break;
    case 'track-list': {
      let list = [];
      try { list = JSON.parse(v || '[]'); } catch { list = []; }
      const t = XPCore.mpvTracks(list);
      P.tracks.audio = t.audio; P.tracks.subs = t.subs;
      if (t.aid) M.aid = t.aid;
      P.subIndex = t.subs.findIndex((s) => s.index === t.sid);
      renderTracksMenu();
      break;
    }
    case 'aid': M.aid = parseInt(v, 10) || 0; renderTracksMenu(); break;
    case 'sid': M.sid = parseInt(v, 10) || 0; P.subIndex = P.tracks.subs.findIndex((s) => s.index === M.sid); renderTracksMenu(); break;
    case 'video-format': M.tech.vcodec = v || ''; updateTech(); break;
    case 'audio-codec-name': M.tech.acodec = v || ''; updateTech(); break;
    case 'width': M.tech.width = parseInt(v, 10) || 0; updateTech(); break;
    case 'height': M.tech.height = parseInt(v, 10) || 0; updateTech(); break;
    case 'audio-params/channel-count': M.tech.channels = parseInt(v, 10) || 0; updateTech(); break;
    case 'hwdec-current': M.tech.hwdec = v || ''; updateTech(); break;
    case 'end-file': onMpvEnd(v || {}); break;
    default: break;
  }
}

function onMpvEnd(v) {
  // "stop" e "redirect" arrivano anche quando si apre un altro contenuto
  if (v.reason !== 'eof' && v.reason !== 'error') return;
  const item = S.current, mode = S.currentMode;
  if (!item) return;
  if (mode === 'live') { onLiveError(v.reason === 'eof' ? 'lo stream si è interrotto' : (v.error || 'errore di mpv')); return; }
  if (v.reason === 'error') { mpvStop(); showError(`Impossibile riprodurre il film: ${v.error || 'errore di mpv'}.`); return; }
  const rk = resumeKey(item);
  if (rk) lsDel(rk);
  // mpv resta inattivo sul nero: si nasconde il video (l'episodio successivo lo riapre)
  mpvStop();
  setStatus('Terminato');
  updatePlayButton();
  onPlaybackEnded(item);
}

function updateMpvCacheUi() {
  const el = $('info-latency');
  if (!mpvActive() || S.currentMode !== 'live') { if (M.loaded) el.textContent = ''; return; }
  el.textContent = `Buffer ${M.cache.toFixed(1)} s · ${ENGINE_NAME}`;
}

// ------------------------------------------------------------------ avvio
async function initMpv() {
  try { M.available = !!(await invoke('mpv_available')); } catch { M.available = false; }
  if (TAURI.event) TAURI.event.listen('mpv', (e) => onMpvEvent(e.payload)).catch(() => {});
  renderSettings();
}

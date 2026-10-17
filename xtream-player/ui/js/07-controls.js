// Controlli del player, menu impostazioni e azioni del pannello info.
'use strict';

// ------------------------------------------------------------------ controlli custom
const seek = $('seek'), volume = $('volume'), wrap = $('player-wrap');
let seeking = false;

function setRangeFill(el) { const p = ((el.value - el.min) / (el.max - el.min)) * 100; el.style.setProperty('--p', p + '%'); }
function updatePlayButton() {
  $('btn-play').innerHTML = video.paused || !S.current ? ICONS.play : ICONS.pause;
  rowsLayer.querySelectorAll('.eq').forEach((e) => e.classList.toggle('paused', video.paused));
}
function updateVolumeUi() {
  $('btn-mute').innerHTML = video.muted || video.volume === 0 ? ICONS.mute : ICONS.vol;
  volume.value = video.muted ? 0 : Math.round(video.volume * 100);
  setRangeFill(volume);
}
function updateTimeUi() {
  if (!S.current) { $('time').textContent = ''; return; }
  if (S.currentMode === 'live') {
    $('time').textContent = video.currentTime ? fmtTime(video.currentTime) : '';
    return;
  }
  const d = currentDuration(), c = currentPlayTime();
  $('time').textContent = `${fmtTime(c)} / ${isFinite(d) && d > 0 ? fmtTime(d) : '--:--'}`;
  if (!seeking && isFinite(d) && d > 0) { seek.value = Math.round((c / d) * 1000); setRangeFill(seek); }
}

function togglePlay() {
  if (!S.current) return;
  if (video.paused) {
    osd(ICONS.play.replace('w-5 h-5', 'w-8 h-8'));
    if (S.currentMode === 'live' && !P.mpegts && !P.hls && !video.getAttribute('src')) { playItem(S.current, 'live'); return; }
    video.play().catch(() => {});
  } else {
    osd(ICONS.pause.replace('w-5 h-5', 'w-8 h-8'));
    video.pause();
  }
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else wrap.requestFullscreen().catch(() => {});
}
function togglePip() {
  (async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (S.current) await video.requestPictureInPicture();
    } catch (e) { toast('Picture in Picture non disponibile: ' + errText(e), 'error'); }
  })();
}
function setTheater(on) {
  on = !!on;
  $('app-view').classList.toggle('theater', on);
  $('btn-theater').setAttribute('aria-pressed', String(on));
  $('btn-theater').title = on ? 'Esci dalla modalità cinema (T)' : 'Modalità cinema (T)';
  lsSet('xp.theater', on);
  if (!on) { renderList(true); locateCurrent(false); }
}
const theaterOn = () => $('app-view').classList.contains('theater');

function saveVolume() { lsSet('xp.volume', { v: video.volume, m: video.muted }); }
function changeVolume(delta) {
  const v = Math.min(1, Math.max(0, Math.round((video.volume + delta) * 100) / 100));
  video.volume = v;
  video.muted = v === 0;
  saveVolume();
  osd(`${(v === 0 ? ICONS.mute : ICONS.vol).replace('w-5 h-5', 'w-6 h-6')}<span>${Math.round(v * 100)}%</span>`);
}
function seekBy(sec) {
  if (S.currentMode !== 'vod') return;
  seekTo(currentPlayTime() + sec);
  osd(`<span>${sec > 0 ? '+' : '−'}${Math.abs(sec)} s</span>`);
}

$('btn-play').addEventListener('click', togglePlay);
$('btn-stop').addEventListener('click', () => { destroyPlayer(); resetPlayerUi(); });
$('btn-mute').addEventListener('click', () => {
  if (video.muted || video.volume === 0) { video.muted = false; if (video.volume === 0) video.volume = 0.5; }
  else video.muted = true;
  saveVolume();
});
volume.addEventListener('input', () => {
  video.volume = volume.value / 100;
  video.muted = video.volume === 0;
  setRangeFill(volume);
  saveVolume();
});
seek.addEventListener('input', () => {
  seeking = true; setRangeFill(seek);
  const d = currentDuration();
  if (isFinite(d) && d > 0) $('time').textContent = `${fmtTime((seek.value / 1000) * d)} / ${fmtTime(d)}`;
});
seek.addEventListener('change', () => {
  const d = currentDuration();
  if (isFinite(d) && d > 0) seekTo((seek.value / 1000) * d);
  seeking = false;
});
// anteprima del tempo sotto il cursore
seek.addEventListener('mousemove', (ev) => {
  const d = currentDuration(), tip = $('seek-tip');
  if (!isFinite(d) || d <= 0) { tip.classList.add('hidden'); return; }
  const r = seek.getBoundingClientRect();
  const x = Math.min(r.width, Math.max(0, ev.clientX - r.left));
  tip.textContent = fmtTime((x / r.width) * d);
  tip.style.left = Math.min(r.width - 24, Math.max(24, x)) + 'px';
  tip.classList.remove('hidden');
});
seek.addEventListener('mouseleave', () => $('seek-tip').classList.add('hidden'));

// --- menu impostazioni live (buffer e modalità stream) ---
function updateSettingsMenu() {
  document.querySelectorAll('#settings-menu [data-lat]').forEach((b) => {
    b.classList.toggle('on', b.dataset.lat === L.mode); b.setAttribute('aria-checked', String(b.dataset.lat === L.mode));
  });
  document.querySelectorAll('#settings-menu [data-fmt]').forEach((b) => {
    b.classList.toggle('on', b.dataset.fmt === S.liveFormat); b.setAttribute('aria-checked', String(b.dataset.fmt === S.liveFormat));
  });
}
const settingsOpen = () => !$('settings-menu').classList.contains('hidden');
function closeSettings() {
  $('settings-menu').classList.add('hidden');
  $('btn-settings').setAttribute('aria-expanded', 'false');
}
$('btn-settings').addEventListener('click', (ev) => {
  ev.stopPropagation();
  if (settingsOpen()) { closeSettings(); return; }
  updateSettingsMenu();
  $('settings-menu').classList.remove('hidden');
  $('btn-settings').setAttribute('aria-expanded', 'true');
  poke();
});
document.addEventListener('click', (ev) => {
  if (settingsOpen() && !$('settings-menu').contains(ev.target)) closeSettings();
});
$('settings-menu').addEventListener('click', (ev) => {
  const b = ev.target.closest('.menu-opt');
  if (!b) return;
  if (b.dataset.fmt) {
    S.liveFormat = ['ts', 'm3u8', 'ffmpeg'].includes(b.dataset.fmt) ? b.dataset.fmt : 'ts';
    lsSet('xp.liveFormat', S.liveFormat);
    if (S.liveFormat === 'ffmpeg' && !S.caps.ffmpeg) toast('ffmpeg non trovato: installalo con "winget install Gyan.FFmpeg" e riavvia l\'app', 'error');
    if (S.current && S.currentMode === 'live') playItem(S.current, 'live');
  } else if (b.dataset.lat) {
    L.mode = LAT_PRESETS[b.dataset.lat] ? b.dataset.lat : 'min';
    lsSet('xp.latMode', L.mode);
    latLoad();
    if (S.current && S.currentMode === 'live' && P.hls) playItem(S.current, 'live');
    updateLatencyUi(true);
  }
  updateSettingsMenu();
  closeSettings();
});

$('btn-reload').addEventListener('click', () => { if (S.current) playItem(S.current, S.currentMode); });
$('btn-pip').addEventListener('click', togglePip);
$('btn-theater').addEventListener('click', () => setTheater(!theaterOn()));
$('btn-fs').addEventListener('click', toggleFullscreen);
$('btn-prev').addEventListener('click', () => stepChannel(-1));
$('btn-next').addEventListener('click', () => stepChannel(1));
$('btn-back10').addEventListener('click', () => seekBy(-10));
$('btn-fwd10').addEventListener('click', () => seekBy(10));
video.addEventListener('click', togglePlay);
video.addEventListener('dblclick', toggleFullscreen);
wrap.addEventListener('wheel', (ev) => {
  if (!S.current || ev.target.closest('#settings-menu')) return;
  ev.preventDefault();
  changeVolume(ev.deltaY < 0 ? 0.05 : -0.05);
}, { passive: false });
$('err-retry').addEventListener('click', () => { if (S.current) playItem(S.current, S.currentMode); });
$('err-external').addEventListener('click', openExternal);

let idleTimer = null;
function poke() {
  wrap.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!video.paused && S.current && !settingsOpen()) wrap.classList.add('idle'); }, 3000);
}
wrap.addEventListener('mousemove', poke);
wrap.addEventListener('mouseleave', () => { if (!video.paused && S.current && !settingsOpen()) wrap.classList.add('idle'); });
video.addEventListener('pause', () => wrap.classList.remove('idle'));

// ------------------------------------------------------------------ azioni info
async function openExternal() {
  if (!S.current || !S.currentUrl) return;
  const item = S.current, mode = S.currentMode;
  // per i live con limite di 1 connessione si chiude prima lo stream interno
  const url = mode === 'live' ? buildStreamUrl(item, 'live', 'ts') : S.currentUrl;
  try {
    const resumeAt = mode === 'vod' ? currentPlayTime() : 0;
    destroyPlayer();
    setSpinner(false); hideError();
    const used = await invoke('open_in_external_player', { streamUrl: url, title: item.name, live: mode === 'live' });
    setStatus(`Aperto in ${used}` + (resumeAt > 5 ? ` (eri a ${fmtTime(resumeAt)})` : ''));
    toast(`Stream aperto in ${used}`, 'ok');
    updatePlayButton();
  } catch (e) {
    toast(errText(e), 'error');
    setStatus(errText(e));
  }
}
$('btn-external').addEventListener('click', openExternal);

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback sotto */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
$('btn-copy').addEventListener('click', async () => {
  if (!S.currentUrl) return;
  const ok = await copyText(S.currentUrl);
  toast(ok ? 'URL copiato negli appunti' : 'Copia non riuscita', ok ? 'ok' : 'error');
});
$('btn-fav').addEventListener('click', () => { if (S.current) toggleFav(S.currentMode, S.current); });

// Controlli del player, menu tracce, pannello Impostazioni e azioni del pannello info.
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

/// --- menu rapido nel player: traccia audio e sottotitoli ---
const CHECK = '<svg class="chk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';
function trackOpt(attrs, label, on, note, disabled) {
  return `<button class="menu-opt${on ? ' on' : ''}" role="menuitemradio" aria-checked="${on}" ${attrs}${disabled ? ' disabled' : ''}>${CHECK}<span class="truncate">${escapeHtml(label)}</span>${note ? `<small>${escapeHtml(note)}</small>` : ''}</button>`;
}
function renderTracksMenu() {
  const menu = $('tracks-menu');
  const t = P.tracks, live = S.currentMode === 'live';
  const waiting = live ? 'Lettura delle tracce dallo stream…' : (S.caps.ffprobe ? 'Analisi delle tracce del file…' : 'Elenco delle tracce non disponibile senza ffmpeg');
  const empty = t.from === 'hls' ? 'Non disponibile in HLS: scegli "Auto" nelle impostazioni'
    : t.from === 'none' ? 'Elenco delle tracce non disponibile' : t.from ? 'Nessuna traccia' : waiting;
  const listed = t.from === 'ts' || t.from === 'probe';
  const note = (msg) => `<p class="px-2 py-1 text-xs text-ink-subtle">${escapeHtml(msg)}</p>`;
  let html = '<p class="overline px-2 py-1">Audio</p>';
  if (t.audio.length) {
    const cur = currentAudioIndex();
    html += t.audio.map((a, i) => trackOpt(`data-audio="${i}"`, XPCore.trackLabel(a), a.index === cur, '', false)).join('');
  } else html += note(listed ? 'Nessuna traccia audio' : empty);
  html += '<div class="h-px bg-glass-line my-2"></div><p class="overline px-2 py-1">Sottotitoli</p>';
  html += trackOpt('data-sub="-1"', 'Disattivati', P.subIndex < 0, '', false);
  if (t.subs.length) {
    html += t.subs.map((s, i) => {
      // i sottotitoli a immagine (DVB, PGS, DVD) e quelli dei live non si possono mostrare
      const ok = s.text && !live;
      return trackOpt(`data-sub="${i}"`, XPCore.trackLabel(s), P.subIndex === i, ok ? '' : (s.text ? 'solo film' : 'immagine, non disponibile'), !ok);
    }).join('');
  } else if (!listed) html += note(empty);
  html += `<div class="h-px bg-glass-line my-2"></div><button class="menu-opt" data-open-settings>${ICONS.gear}<span>Impostazioni…</span></button>`;
  menu.innerHTML = html;
}
const tracksMenuOpen = () => !$('tracks-menu').classList.contains('hidden');
function closeTracksMenu() {
  $('tracks-menu').classList.add('hidden');
  $('btn-tracks').setAttribute('aria-expanded', 'false');
}
$('btn-tracks').addEventListener('click', (ev) => {
  ev.stopPropagation();
  if (tracksMenuOpen()) { closeTracksMenu(); return; }
  renderTracksMenu();
  $('tracks-menu').classList.remove('hidden');
  $('btn-tracks').setAttribute('aria-expanded', 'true');
  poke();
});
document.addEventListener('click', (ev) => {
  if (tracksMenuOpen() && !$('tracks-menu').contains(ev.target)) closeTracksMenu();
});
$('tracks-menu').addEventListener('click', (ev) => {
  const b = ev.target.closest('.menu-opt');
  if (!b || b.disabled) return;
  closeTracksMenu();
  if (b.hasAttribute('data-open-settings')) { openSettings(); return; }
  if (b.dataset.audio != null) selectAudio(P.tracks.audio[+b.dataset.audio], false);
  else if (b.dataset.sub != null) {
    const i = +b.dataset.sub;
    if (i !== P.subIndex) { setSubtitle(i); toast(i < 0 ? 'Sottotitoli disattivati' : 'Sottotitoli: ' + XPCore.trackLabel(P.tracks.subs[i])); }
  }
});

// --- pannello Impostazioni (finestra modale) ---
const settingsPanelOpen = () => !$('settings-panel').classList.contains('hidden');
let settingsReturnFocus = null;
function saveSettings() { lsSet('xp.settings', S.settings); }
function fillLangSelect(sel, value, noneLabel) {
  const codes = XPCore.PREFERRED_LANGS.includes(value) || !value ? XPCore.PREFERRED_LANGS : [value, ...XPCore.PREFERRED_LANGS];
  sel.innerHTML = `<option value="">${escapeHtml(noneLabel)}</option>` +
    codes.map((c) => `<option value="${c}">${escapeHtml(XPCore.langName(c))}</option>`).join('');
  sel.value = value || '';
}
function renderSettings() {
  const st = S.settings;
  const segValue = { lat: L.mode, fmt: S.liveFormat, audioOut: st.audioOut, quality: st.quality, external: st.external };
  document.querySelectorAll('#settings-panel .seg').forEach((g) => {
    g.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.v === segValue[g.dataset.setting];
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  });
  fillLangSelect($('set-audio-lang'), st.audioLang, 'Nessuna preferenza');
  fillLangSelect($('set-sub-lang'), st.subLang, 'Disattivati');
  const c = S.caps || {};
  $('set-ffmpeg').innerHTML = c.ffmpeg
    ? `<span class="text-success font-bold">ffmpeg attivo</span> · encoder video <span class="text-ink font-bold">${escapeHtml(c.h264_encoder || 'software')}</span>
       <span class="block text-ink-subtle font-mono text-[11px] truncate mt-1" title="${escapeHtml(c.ffmpeg)}">${escapeHtml(c.version || c.ffmpeg)}</span>`
    : '<span class="text-accent-ink font-bold">ffmpeg non trovato</span>: AC3/DTS/HEVC/MPEG-2, cambio traccia audio e sottotitoli non disponibili. ffmpeg è incluso nell\'installer: reinstalla l\'app, oppure installalo con <span class="font-mono">winget install Gyan.FFmpeg</span> e riavvia.';
}
function openSettings() {
  closeTracksMenu();
  settingsReturnFocus = document.activeElement;
  renderSettings();
  $('settings-panel').classList.remove('hidden');
  $('settings-close').focus();
}
function closeSettings() {
  if (!settingsPanelOpen()) return;
  $('settings-panel').classList.add('hidden');
  if (settingsReturnFocus && settingsReturnFocus.focus) settingsReturnFocus.focus();
}
// le scelte che cambiano la conversione si applicano subito allo stream in corso
function restartIfTranscoding() {
  if (!S.current || P.route.mode !== 'transcode') return;
  if (S.currentMode === 'vod') playItem(S.current, 'vod', { keepRetries: true, route: P.route, ss: currentPlayTime(), duration: currentDuration() });
  else playItem(S.current, 'live', { keepRetries: true, route: P.route, fmt: P.fmt });
}
$('settings-btn').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', closeSettings);
$('settings-panel').addEventListener('click', (ev) => { if (ev.target === $('settings-panel')) closeSettings(); });
$('settings-panel').addEventListener('click', (ev) => {
  const b = ev.target.closest('.seg button');
  if (!b) return;
  const key = b.closest('.seg').dataset.setting, v = b.dataset.v;
  if (key === 'lat') {
    L.mode = LAT_PRESETS[v] ? v : 'min';
    lsSet('xp.latMode', L.mode);
    latLoad();
    if (S.current && S.currentMode === 'live' && P.hls) playItem(S.current, 'live');
    updateLatencyUi(true);
  } else if (key === 'fmt') {
    S.liveFormat = ['ts', 'm3u8', 'ffmpeg'].includes(v) ? v : 'ts';
    lsSet('xp.liveFormat', S.liveFormat);
    if (S.liveFormat === 'ffmpeg' && !S.caps.ffmpeg) toast('ffmpeg non trovato: installalo con "winget install Gyan.FFmpeg" e riavvia l\'app', 'error');
    if (S.current && S.currentMode === 'live') playItem(S.current, 'live');
  } else if (key in S.settings) {
    if (S.settings[key] === v) return;
    S.settings = XPCore.normalizeSettings({ ...S.settings, [key]: v });
    saveSettings();
    if (key === 'audioOut' || key === 'quality') restartIfTranscoding();
  }
  renderSettings();
});
['set-audio-lang', 'set-sub-lang'].forEach((id) => $(id).addEventListener('change', (ev) => {
  const key = id === 'set-audio-lang' ? 'audioLang' : 'subLang';
  S.settings = XPCore.normalizeSettings({ ...S.settings, [key]: ev.target.value });
  saveSettings();
  toast(key === 'audioLang' ? 'Lingua audio preferita: ' + (S.settings.audioLang ? XPCore.langName(S.settings.audioLang) : 'nessuna') : 'Sottotitoli: ' + (S.settings.subLang ? XPCore.langName(S.settings.subLang) : 'disattivati'), 'ok');
}));
$('set-clear-cache').addEventListener('click', async () => {
  try {
    await invoke('clear_list_cache');
    S.listAge.clear();
    toast('Cache delle liste svuotata: al prossimo avvio si riscaricano dal server', 'ok');
  } catch (e) { toast(errText(e), 'error'); }
});
$('set-redetect').addEventListener('click', async () => {
  const b = $('set-redetect');
  b.disabled = true;
  $('set-ffmpeg').textContent = 'Rilevamento di ffmpeg e prova degli encoder…';
  try { S.caps = await invoke('get_media_capabilities', { refresh: true }); } catch (e) { toast(errText(e), 'error'); }
  b.disabled = false;
  renderCaps();
  renderSettings();
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
  if (!S.current || ev.target.closest('#tracks-menu')) return;
  ev.preventDefault();
  changeVolume(ev.deltaY < 0 ? 0.05 : -0.05);
}, { passive: false });
$('err-retry').addEventListener('click', () => { if (S.current) playItem(S.current, S.currentMode); });
$('err-external').addEventListener('click', openExternal);

let idleTimer = null;
function poke() {
  wrap.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!video.paused && S.current && !tracksMenuOpen()) wrap.classList.add('idle'); }, 3000);
}
wrap.addEventListener('mousemove', poke);
wrap.addEventListener('mouseleave', () => { if (!video.paused && S.current && !tracksMenuOpen()) wrap.classList.add('idle'); });
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
    const used = await invoke('open_in_external_player', { streamUrl: url, title: item.name, live: mode === 'live', prefer: S.settings.external });
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
$('btn-fav').addEventListener('click', () => { const t = favTarget(); if (t) toggleFav(t.mode, t.item); });

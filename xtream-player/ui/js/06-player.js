// Player: mpegts.js/hls.js, conversione ffmpeg, buffer adattivo, eventi del video.
'use strict';

// ------------------------------------------------------------------ player
const video = $('video');
const P = {
  mpegts: null, hls: null, retries: 0, retryTimer: null, watchdog: null, healthTimer: null, startTimer: null,
  lastTime: 0, stallTicks: 0, fmt: 'ts', mediaInfo: null, hadPlaying: false,
  route: { mode: 'direct', v: 'copy', a: 'copy' },
  vodTranscoded: false, vodOffset: 0, vodDuration: NaN,
};
S.caps = { ffmpeg: null, ffprobe: null, h264_encoder: null, version: '' };

function buildStreamUrl(item, mode, fmt) { return XPCore.buildStreamUrl(S.creds, item, mode, fmt); }
function proxied(url) { return XPCore.proxyUrl(S.proxy, url); }
function transcodeUrl(url, r, opts) { return XPCore.transcodeUrl(S.proxy, url, r, opts); }

// --- supporto codec di WebView2 (MSE) ---
const mseOk = (t) => { try { return !!window.MediaSource && MediaSource.isTypeSupported(t); } catch { return false; } };
const HEVC_OK = mseOk('video/mp4; codecs="hvc1.1.6.L120.90"') || mseOk('video/mp4; codecs="hev1.1.6.L120.90"');
const HEVC10_OK = mseOk('video/mp4; codecs="hvc1.2.4.L120.90"');
function mseVideoOk(codec) { return !codec || mseOk(`video/mp4; codecs="${codec}"`); }
function mseAudioOk(codec) { return !codec || mseOk(XPCore.audioMime(codec)); }
// cosa si può copiare senza conversione (decisione in XPCore, con i codec che WebView2 supporta)
function probeVideoOk(info) { return XPCore.probeVideoOk(info, { hevc: HEVC_OK, hevc10: HEVC10_OK }); }
function probeAudioOk(info) { return XPCore.probeAudioOk(info, mseOk('audio/mp4; codecs="opus"')); }
async function probeRoute(url) {
  const info = await invoke('probe_stream', { streamUrl: url });
  return { info, route: { mode: 'transcode', v: probeVideoOk(info) ? 'copy' : 'h264', a: probeAudioOk(info) ? 'copy' : 'aac' } };
}

// --- percorso di conversione memorizzato per canale ---
const routeKey = (id) => 'xp.route.' + id;
function getSavedRoute(id) { return XPCore.normalizeSavedRoute(lsGet(routeKey(id), null)); }
function saveRoute(id, r) { lsSet(routeKey(id), { v: r.v, a: r.a, t: Date.now() }); }
const { mergeRoute } = XPCore;
function describeRoute(r) { return XPCore.describeRoute(r, S.caps.h264_encoder); }

async function escalate(item, mode, wanted, reason) {
  if (S.current !== item) return false;
  if (!S.caps.ffmpeg) {
    try { S.caps = await invoke('get_media_capabilities', { refresh: true }); renderCaps(); } catch { /* resta senza ffmpeg */ }
  }
  if (S.current !== item) return false;
  if (!S.caps.ffmpeg) {
    setHint(`${reason}. Per riprodurlo nel player integrato installa ffmpeg (winget install Gyan.FFmpeg), oppure usa "Apri in MPV/VLC esterno".`);
    return false;
  }
  const base = P.route.mode === 'transcode' ? P.route : { v: 'copy', a: 'copy' };
  const route = mergeRoute(base, wanted);
  if (P.route.mode === 'transcode' && route.v === P.route.v && route.a === P.route.a) return false;
  if (mode === 'live') saveRoute(item.stream_id, route);
  toast(`${reason} → ${describeRoute(route)}`);
  const opts = { route, keepRetries: true };
  if (mode === 'vod') { opts.ss = currentPlayTime(); opts.duration = currentDuration(); }
  playItem(item, mode, opts);
  return true;
}

// --- buffer adattivo per i live: il più piccolo possibile, cresce solo se ci sono scatti ---
const LAT_PRESETS = {
  min: { start: 1.0, floor: 0.6 },
  bal: { start: 2.5, floor: 2.0 },
  stable: { start: 5.0, floor: 4.0 },
};
const L = { mode: 'min', target: 1, timer: null, lastStall: 0, lastDecrease: 0, lastJump: 0, stalls: 0, ahead: 0 };
L.mode = LAT_PRESETS[lsGet('xp.latMode', 'min')] ? lsGet('xp.latMode', 'min') : 'min';
function latPreset() { return LAT_PRESETS[L.mode]; }
function latLoad() {
  const p = latPreset();
  const saved = Number(lsGet('xp.latTarget.' + L.mode, p.start));
  L.target = Math.min(8, Math.max(p.floor, isFinite(saved) ? saved : p.start));
}
function latSave() { lsSet('xp.latTarget.' + L.mode, Math.round(L.target * 100) / 100); }
function bufferAhead() {
  const b = video.buffered;
  if (!b.length) return 0;
  return Math.max(0, b.end(b.length - 1) - video.currentTime);
}
function latStart() {
  latStop();
  latLoad();
  L.lastStall = L.lastDecrease = performance.now();
  L.stalls = 0;
  L.timer = setInterval(latTick, 250);
}
function latStop() {
  clearInterval(L.timer);
  L.timer = null;
  if (video.playbackRate !== 1) video.playbackRate = 1;
  updateLatencyUi(true);
}
function latTick() {
  if (video.paused || video.readyState < 3) { updateLatencyUi(); return; }
  const ahead = bufferAhead();
  L.ahead = ahead;
  const t = L.target, b = video.buffered;
  if (XPCore.latencyStep(ahead, t).jump && b.length) {
    // troppo indietro (es. dopo una pausa): salto al bordo live mantenendo il margine
    L.lastJump = performance.now();
    video.currentTime = b.end(b.length - 1) - t;
    video.playbackRate = 1;
    updateLatencyUi();
    return;
  }
  // recupero morbido con la velocità (pitch preservato), niente salti udibili
  const rate = XPCore.latencyStep(ahead, t).rate;
  if (Math.abs(video.playbackRate - rate) > 0.004) video.playbackRate = rate;
  const now = performance.now(), p = latPreset();
  if (t > p.floor && now - L.lastStall > 45000 && now - L.lastDecrease > 30000) {
    L.target = XPCore.relaxTarget(t, p.floor);
    L.lastDecrease = now;
    latSave();
  }
  updateLatencyUi();
}
function latOnStall() {
  if (performance.now() - L.lastJump < 1500) return;
  L.stalls += 1;
  L.target = XPCore.stallTarget(L.target);
  L.lastStall = performance.now();
  latSave();
}
let latUiLast = 0;
function updateLatencyUi(force) {
  const now = performance.now();
  if (!force && now - latUiLast < 500) return;
  latUiLast = now;
  const el = $('info-latency');
  if (!S.current || S.currentMode !== 'live' || !L.timer) { el.textContent = ''; return; }
  el.textContent = `Buffer ${L.ahead.toFixed(1)} s · obiettivo ${L.target.toFixed(1)} s · velocità ${video.playbackRate.toFixed(2)}×` +
    (L.stalls ? ` · ${L.stalls} scatt${L.stalls === 1 ? 'o' : 'i'}: buffer aumentato` : '');
}

function destroyPlayer() {
  clearTimeout(P.retryTimer); P.retryTimer = null;
  clearInterval(P.watchdog); P.watchdog = null;
  clearTimeout(P.healthTimer); P.healthTimer = null;
  clearInterval(P.startTimer); P.startTimer = null;
  latStop();
  if (P.mpegts) {
    const m = P.mpegts; P.mpegts = null;
    try { m.pause(); } catch { /* già fermo */ }
    try { m.unload(); } catch { /* già scaricato */ }
    try { m.detachMediaElement(); } catch { /* già staccato */ }
    try { m.destroy(); } catch { /* già distrutto */ }
  }
  if (P.hls) {
    const h = P.hls; P.hls = null;
    try { h.destroy(); } catch { /* già distrutto */ }
  }
  video.removeAttribute('src');
  try { video.load(); } catch { /* nessuna sorgente */ }
  P.mediaInfo = null;
}

function setSpinner(on) { $('player-spinner').classList.toggle('hidden', !on); }
function setStatus(msg) { $('info-status').textContent = msg || ''; $('spinner-text').textContent = msg || ''; }

// --- OSD: titolo in alto (schermo intero / cinema) e messaggi brevi al centro ---
let osdTopTimer = null, osdCenterTimer = null;
function showOsdTop(item, mode) {
  const el = $('osd-top');
  if (!item) { el.classList.remove('on', 'force'); return; }
  const logo = $('osd-logo');
  logo.textContent = initials(item.name);
  if (item.stream_icon && /^https?:\/\//i.test(item.stream_icon)) {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.className = 'w-full h-full object-contain';
    img.onload = () => { if (S.current === item) { logo.textContent = ''; logo.appendChild(img); } };
    img.src = item.stream_icon;
  }
  $('osd-name').textContent = (mode === 'live' && item.num ? item.num + '  ·  ' : '') + item.name;
  $('osd-sub').textContent = S.catNames[mode].get(item.category_id) || (mode === 'live' ? 'Live TV' : 'Film');
  el.classList.add('on', 'force');
  clearTimeout(osdTopTimer);
  osdTopTimer = setTimeout(() => el.classList.remove('force'), 4000);
}
function osd(html) {
  const el = $('osd-center');
  el.innerHTML = html;
  el.classList.remove('opacity-0');
  clearTimeout(osdCenterTimer);
  osdCenterTimer = setTimeout(() => el.classList.add('opacity-0'), 800);
}
function setHint(msg) { const el = $('info-hint'); el.textContent = msg || ''; el.classList.toggle('hidden', !msg); }
function showError(msg) {
  setSpinner(false);
  $('player-error-text').textContent = msg;
  $('player-error').classList.remove('hidden');
  setStatus('Errore di riproduzione');
}
function hideError() { $('player-error').classList.add('hidden'); }

function resetPlayerUi() {
  S.current = null; S.currentMode = null; S.currentUrl = '';
  $('player-empty').classList.remove('hidden');
  hideError(); setSpinner(false); setHint(''); setStatus('');
  $('info-name').textContent = 'Nessun contenuto in riproduzione';
  $('info-cat').textContent = ''; $('info-tech').textContent = ''; $('info-latency').textContent = '';
  $('info-type').classList.add('hidden');
  $('info-logo').innerHTML = '';
  ['btn-external', 'btn-copy', 'btn-fav'].forEach((id) => { $(id).disabled = true; });
  $('seek-row').classList.add('hidden'); $('live-badge').classList.add('hidden');
  ['btn-prev', 'btn-next', 'btn-back10', 'btn-fwd10', 'btn-settings'].forEach((id) => $(id).classList.add('hidden'));
  closeSettings();
  showOsdTop(null);
  $('time').textContent = '';
  updatePlayButton();
  updateFavButton();
  renderList(true);
  updateLocateButton();
}

function renderInfo(item, mode) {
  $('player-empty').classList.add('hidden');
  $('info-name').textContent = item.name;
  $('info-name').title = item.name;
  const type = $('info-type');
  type.classList.remove('hidden');
  type.textContent = mode === 'live' ? 'LIVE' : 'VOD';
  type.className = 'text-[10px] font-bold tracking-wider rounded px-1.5 py-0.5 ' + (mode === 'live' ? 'bg-red-600 text-white' : 'bg-indigo-600 text-white');
  const catName = S.catNames[mode].get(item.category_id) || '';
  const parts = [catName, item.num ? `N. ${item.num}` : '', mode === 'vod' && item.rating > 0 ? `★ ${Number(item.rating).toFixed(1)}` : ''].filter(Boolean);
  $('info-cat').textContent = parts.join(' · ');
  const logo = $('info-logo');
  if (item.stream_icon && /^https?:\/\//i.test(item.stream_icon)) {
    logo.innerHTML = `<img src="${escapeHtml(item.stream_icon)}" referrerpolicy="no-referrer" class="w-full h-full object-contain" alt="">`;
    const img = logo.querySelector('img');
    img.addEventListener('error', () => { logo.textContent = initials(item.name); }, { once: true });
  } else {
    logo.textContent = initials(item.name);
  }
  ['btn-external', 'btn-copy', 'btn-fav'].forEach((id) => { $(id).disabled = false; });
  $('seek-row').classList.toggle('hidden', mode === 'live');
  $('live-badge').classList.toggle('hidden', mode !== 'live');
  ['btn-prev', 'btn-next', 'btn-settings'].forEach((id) => $(id).classList.toggle('hidden', mode !== 'live'));
  ['btn-back10', 'btn-fwd10'].forEach((id) => $(id).classList.toggle('hidden', mode !== 'vod'));
  if (mode !== 'live') closeSettings();
  updateFavButton();
  updateTech();
}

function updateFavButton() {
  const b = $('btn-fav');
  const fav = !!S.current && isFav(S.currentMode, S.current.stream_id);
  b.innerHTML = `<span class="${fav ? 'text-amber-400' : ''}">${fav ? ICONS.star : ICONS.starO}</span>${fav ? 'Preferito' : 'Preferiti'}`;
  b.title = fav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti';
  b.setAttribute('aria-pressed', String(fav));
}

function updateTech() {
  if (!S.current) { $('info-tech').textContent = ''; return; }
  const bits = [];
  const tr = P.route.mode === 'transcode';
  if (S.currentMode === 'live') {
    bits.push(P.fmt === 'm3u8' ? 'HLS (hls.js)' : (tr ? 'MPEG-TS via ffmpeg' : 'MPEG-TS diretto'));
  } else {
    const ext = (S.current.container_extension || 'mp4').toUpperCase();
    bits.push(ext + (P.vodTranscoded ? (P.route.v === 'copy' && P.route.a === 'copy' ? ' (remux ffmpeg)' : ' (ffmpeg)') : ' (diretto)'));
  }
  if (tr) bits.push(describeRoute(P.route));
  if (video.videoWidth) bits.push(`${video.videoWidth}×${video.videoHeight}`);
  const mi = P.mediaInfo;
  if (mi) {
    if (mi.videoCodec) bits.push(mi.videoCodec);
    if (mi.audioCodec) bits.push(mi.audioCodec);
    if (mi.fps) bits.push(Math.round(mi.fps) + ' fps');
  }
  $('info-tech').textContent = bits.join(' · ');
}

function playItem(item, mode, opts) {
  opts = opts || {};
  destroyPlayer();
  hideError();
  setHint('');
  S.current = item;
  S.currentMode = mode;
  if (!opts.keepRetries) P.retries = 0;
  P.hadPlaying = false;
  P.route = { mode: 'direct', v: 'copy', a: 'copy' };
  P.vodTranscoded = false;
  P.vodOffset = 0;
  P.vodDuration = opts.duration && isFinite(opts.duration) ? opts.duration : NaN;
  renderInfo(item, mode);
  if (!opts.keepRetries) { pushRecent(mode, item); showOsdTop(item, mode); }
  renderList(true);
  updateLocateButton();
  setSpinner(true);
  if (mode === 'live') startLive(item, opts.fmt || S.liveFormat, opts.route);
  else startVod(item, opts);
}

function mpegtsReady() { return !!(window.mpegts && mpegts.isSupported() && mpegts.getFeatureList().mseLivePlayback); }

function startLive(item, fmt, forcedRoute) {
  P.fmt = fmt;
  const tsUrl = buildStreamUrl(item, 'live', 'ts');
  if (fmt === 'm3u8' || !mpegtsReady()) {
    const hlsUrl = buildStreamUrl(item, 'live', 'm3u8');
    P.fmt = 'm3u8';
    S.currentUrl = hlsUrl;
    updateTech();
    setStatus('Connessione allo stream HLS…');
    if (window.Hls && Hls.isSupported()) startHls(hlsUrl, true);
    else { video.src = proxied(hlsUrl); video.play().catch(() => {}); }
    startWatchdog();
    return;
  }
  S.currentUrl = tsUrl;
  let route = forcedRoute || null;
  if (!route && fmt === 'ffmpeg') route = { mode: 'transcode', v: 'copy', a: 'aac' };
  if (!route) route = getSavedRoute(item.stream_id);
  if (route && !S.caps.ffmpeg) route = null;
  if (route) {
    P.route = route;
    setStatus(`Conversione in tempo reale: ${describeRoute(route)}`);
    startMpegts(transcodeUrl(tsUrl, route, { live: true }), true, item, 'live');
  } else {
    setStatus('Connessione allo stream…');
    startMpegts(proxied(tsUrl), true, item, 'live');
  }
  updateTech();
  startWatchdog();
}

function startMpegts(src, isLive, item, mode) {
  const config = isLive
    ? {
        enableWorker: true,
        lazyLoad: false,
        enableStashBuffer: false,
        liveBufferLatencyChasing: false,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 20,
        autoCleanupMinBackwardDuration: 10,
        fixAudioTimestampGap: true,
      }
    : {
        enableWorker: true,
        lazyLoad: true,
        lazyLoadMaxDuration: 120,
        lazyLoadRecoverDuration: 30,
        enableStashBuffer: true,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 60,
        autoCleanupMinBackwardDuration: 30,
        fixAudioTimestampGap: true,
      };
  const player = mpegts.createPlayer({ type: 'mpegts', isLive, url: src }, config);
  P.mpegts = player;
  player.on(mpegts.Events.ERROR, (type, detail, info) => {
    if (P.mpegts !== player) return;
    onMpegtsError(item, mode, type, detail, info);
  });
  player.on(mpegts.Events.MEDIA_INFO, (mi) => {
    if (P.mpegts !== player) return;
    onMediaInfo(item, mode, mi);
  });
  player.attachMediaElement(video);
  player.load();
  if (isLive) {
    latLoad();
    gatedStart(player);
  } else {
    const pr = player.play();
    if (pr && pr.catch) pr.catch(() => { /* autoplay bloccato */ });
  }
}

// Molti server Xtream, alla connessione, inviano in ~1 s il proprio buffer (anche 20-30 s
// di video vecchio) e poi proseguono in tempo reale. Si attende la fine della raffica,
// si salta al bordo live da fermi e si parte con il buffer obiettivo: niente ritardo e
// nessun salto visibile dopo l'avvio.
function gatedStart(player) {
  const need = Math.min(1.0, Math.max(0.3, L.target * 0.6));
  const t0 = performance.now();
  const hist = [];
  let firstDataAt = 0;
  clearInterval(P.startTimer);
  P.startTimer = setInterval(() => {
    if (P.mpegts !== player) { clearInterval(P.startTimer); P.startTimer = null; return; }
    const now = performance.now(), b = video.buffered;
    const end = b.length ? b.end(b.length - 1) : 0;
    if (end > 0 && !firstDataAt) firstDataAt = now;
    hist.push([now, end]);
    while (hist.length && now - hist[0][0] > 400) hist.shift();
    const span = hist.length > 1 ? (hist[hist.length - 1][0] - hist[0][0]) / 1000 : 0;
    const rate = span > 0 ? (hist[hist.length - 1][1] - hist[0][1]) / span : 0;
    const ahead = bufferAhead();
    const settled = firstDataAt && now - firstDataAt >= 400 && rate < 2.5;
    const giveUp = (firstDataAt && now - firstDataAt > 3000) || now - t0 > 8000;
    if (!((ahead >= need && settled) || (ahead > 0 && giveUp) || now - t0 > 10000)) return;
    clearInterval(P.startTimer); P.startTimer = null;
    if (b.length && ahead > L.target + 0.5) {
      L.lastJump = now;
      video.currentTime = Math.max(b.start(b.length - 1), end - L.target);
    }
    const pr = player.play();
    if (pr && pr.catch) pr.catch(() => { /* autoplay bloccato: l'utente può premere play */ });
  }, 40);
}

function onMediaInfo(item, mode, mi) {
  P.mediaInfo = mi;
  updateTech();
  if (P.route.mode !== 'direct' || !mi) return;
  const { wanted, bad } = XPCore.mediaInfoRoute(mi, mode, { videoOk: mseVideoOk, audioOk: mseAudioOk });
  if (bad.length) escalate(item, mode, wanted, 'Codec non supportato da WebView2 (' + bad.join(', ') + ')');
}

function onMpegtsError(item, mode, type, detail, info) {
  const msg = (info && (info.msg || info.code)) ? `${detail} (${info.msg || info.code})` : `${type}: ${detail}`;
  const fail = () => {
    if (S.current !== item) return;
    if (mode === 'vod') { destroyPlayer(); showError(`Riproduzione interrotta: ${msg}`); } else onLiveError(msg);
  };
  const decodeProblem = type === mpegts.ErrorTypes.MEDIA_ERROR || /MSE|codec|unsupported/i.test(`${detail} ${info && info.msg ? info.msg : ''}`);
  if (decodeProblem) {
    const mi = P.mediaInfo || {};
    const audioOk = mi.audioCodec && !/^mp3/i.test(mi.audioCodec) && mseAudioOk(mi.audioCodec);
    const vB = video.webkitVideoDecodedByteCount;
    const videoBad = (mi.videoCodec && !mseVideoOk(mi.videoCodec)) || (audioOk && typeof vB === 'number' && vB === 0);
    const wanted = { v: videoBad ? 'h264' : 'copy', a: audioOk ? 'copy' : 'aac' };
    if (P.route.mode === 'transcode' && P.route.a === 'aac') wanted.v = 'h264';
    escalate(item, mode, wanted, 'Errore di decodifica').then((done) => { if (!done) fail(); });
    return;
  }
  fail();
}

// dopo 4 s di riproduzione: se una traccia non viene decodificata, si converte solo quella
function scheduleHealthCheck(item, mode) {
  clearTimeout(P.healthTimer);
  P.healthTimer = setTimeout(() => healthCheck(item, mode), 4000);
}
function healthCheck(item, mode) {
  if (S.current !== item || video.paused || video.readyState < 2) return;
  const vB = video.webkitVideoDecodedByteCount, aB = video.webkitAudioDecodedByteCount;
  if (typeof vB !== 'number' || typeof aB !== 'number') return;
  const mi = P.mediaInfo;
  const expectVideo = mi ? mi.hasVideo !== false : true;
  const expectAudio = mi ? mi.hasAudio !== false : mode === 'vod';
  const wanted = { v: 'copy', a: 'copy' }, bad = [];
  if (expectVideo && P.route.v !== 'h264' && (vB === 0 || video.videoWidth === 0)) { wanted.v = 'h264'; bad.push('video'); }
  if (expectAudio && P.route.a !== 'aac' && aB === 0) { wanted.a = 'aac'; bad.push('audio'); }
  if (bad.length) escalate(item, mode, wanted, `Nessun ${bad.join(' né ')} decodificato`);
}

function startHls(url, isLive) {
  const stable = L.mode === 'stable';
  const hls = new Hls({
    enableWorker: true,
    lowLatencyMode: true,
    liveSyncDurationCount: stable ? 3 : 2,
    liveMaxLatencyDurationCount: stable ? 6 : 4,
    maxLiveSyncPlaybackRate: 1.1,
    maxBufferLength: isLive ? 10 : 60,
    backBufferLength: isLive ? 10 : 30,
    manifestLoadingMaxRetry: 3,
    levelLoadingMaxRetry: 4,
    fragLoadingMaxRetry: 6,
  });
  P.hls = hls;
  hls.on(Hls.Events.MANIFEST_PARSED, () => { if (P.hls === hls) video.play().catch(() => {}); });
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (P.hls !== hls || !data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
    const code = data.response && data.response.code ? ` HTTP ${data.response.code}` : '';
    if (S.currentMode === 'vod') { destroyPlayer(); showError(`Errore HLS: ${data.details}${code}`); return; }
    onLiveError(`${data.details}${code}`);
  });
  hls.loadSource(proxied(url));
  hls.attachMedia(video);
}

function onLiveError(msg) {
  if (!S.current || S.currentMode !== 'live') return;
  const item = S.current;
  P.retries += 1;
  if (P.retries <= 3) {
    // al secondo errore in MPEG-TS si prova HLS, molti provider lo supportano meglio
    const curFmt = P.fmt === 'm3u8' ? 'm3u8' : 'ts';
    const nextFmt = P.retries === 2 ? (curFmt === 'ts' ? 'm3u8' : 'ts') : (P.fmt === 'ffmpeg' ? 'ffmpeg' : curFmt);
    setStatus(`Errore (${msg}). Nuovo tentativo ${P.retries}/3${nextFmt !== P.fmt ? ' in ' + (nextFmt === 'm3u8' ? 'HLS' : 'MPEG-TS') : ''}…`);
    setSpinner(true);
    clearTimeout(P.retryTimer);
    P.retryTimer = setTimeout(() => {
      if (S.current === item) playItem(item, 'live', { keepRetries: true, fmt: nextFmt });
    }, 800 * P.retries);
  } else {
    destroyPlayer();
    showError(`Impossibile riprodurre il canale: ${msg}. Il canale potrebbe essere offline o il limite di connessioni dell'account raggiunto.`);
  }
}

function startWatchdog() {
  clearInterval(P.watchdog);
  P.lastTime = -1; P.stallTicks = 0;
  P.watchdog = setInterval(() => {
    if (!S.current || S.currentMode !== 'live' || video.paused) { P.stallTicks = 0; return; }
    if (video.currentTime === P.lastTime) {
      P.stallTicks += 1;
      if (P.stallTicks >= 3) { P.stallTicks = 0; onLiveError('stream bloccato da oltre 15 secondi'); }
    } else {
      P.stallTicks = 0; P.lastTime = video.currentTime;
      if (P.retries && video.currentTime > 5) P.retries = 0;
    }
  }, 5000);
}

async function startVod(item, opts) {
  const url = buildStreamUrl(item, 'vod');
  S.currentUrl = url;
  const ext = (item.container_extension || 'mp4').toLowerCase();
  const saved = lsGet('xp.resume.' + item.stream_id, 0);
  const resumeAt = opts.ss != null ? opts.ss : (saved > 30 ? saved : 0);
  if (opts.route) { startVodTranscoded(item, url, opts.route, resumeAt, P.vodDuration, false); return; }
  if (ext === 'm3u8' && window.Hls && Hls.isSupported()) { startHls(url, false); return; }
  const native = ['mp4', 'm4v', 'mov', 'webm'].includes(ext);
  if (!native && S.caps.ffprobe) {
    setStatus('Analisi codec del file…');
    try {
      const { info, route } = await probeRoute(url);
      if (S.current !== item) return;
      startVodTranscoded(item, url, route, resumeAt, info.duration, resumeAt > 0);
      return;
    } catch (e) {
      if (S.current !== item) return;
      setHint(`Analisi non riuscita (${errText(e)}): provo la riproduzione diretta.`);
    }
  } else if (!native && !S.caps.ffmpeg) {
    setHint(`Formato .${ext}: senza ffmpeg il player integrato potrebbe non avere audio (AC3/DTS) o video (HEVC). Installa ffmpeg (winget install Gyan.FFmpeg) o usa "Apri in MPV/VLC esterno".`);
  }
  setStatus('Caricamento film…');
  video.src = proxied(url);
  if (resumeAt > 0) {
    video.addEventListener('loadedmetadata', () => {
      if (S.current === item && isFinite(video.duration) && resumeAt < video.duration - 60) {
        video.currentTime = resumeAt;
        toast(`Ripresa da ${fmtTime(resumeAt)}`);
      }
    }, { once: true });
  }
  video.play().catch(() => {});
}

function startVodTranscoded(item, url, route, ss, duration, announce) {
  P.route = route;
  P.vodTranscoded = true;
  P.vodOffset = ss > 0 ? ss : 0;
  if (duration && isFinite(duration) && duration > 0) P.vodDuration = duration;
  if (P.vodOffset > 0 && isFinite(P.vodDuration) && P.vodOffset > P.vodDuration - 60) P.vodOffset = 0;
  setStatus(route.v === 'copy' && route.a === 'copy' ? 'Remux del file in corso…' : `Conversione in tempo reale: ${describeRoute(route)}`);
  if (announce && P.vodOffset > 0) toast(`Ripresa da ${fmtTime(P.vodOffset)}`);
  updateTech();
  startMpegts(transcodeUrl(url, route, { live: false, ss: P.vodOffset }), false, item, 'vod');
}

function currentPlayTime() { return P.vodTranscoded ? P.vodOffset + video.currentTime : video.currentTime; }
function currentDuration() { return P.vodTranscoded ? P.vodDuration : video.duration; }

const restartTranscodedAt = debounce((t) => {
  if (!S.current || S.currentMode !== 'vod' || !P.vodTranscoded) return;
  playItem(S.current, 'vod', { route: P.route, ss: t, duration: P.vodDuration, keepRetries: true });
}, 250);

function seekTo(t) {
  if (!S.current || S.currentMode !== 'vod') return;
  const d = currentDuration();
  t = Math.max(0, isFinite(d) && d > 0 ? Math.min(d - 1, t) : t);
  if (!P.vodTranscoded) { video.currentTime = t; return; }
  // nel buffer già scaricato si salta subito, altrimenti ffmpeg riparte dal punto scelto
  const rel = t - P.vodOffset, b = video.buffered;
  for (let i = 0; i < b.length; i++) {
    if (rel >= b.start(i) && rel <= b.end(i) - 0.5) { video.currentTime = rel; return; }
  }
  P.vodOffset = t;
  restartTranscodedAt(t);
}

// eventi del tag video
video.addEventListener('playing', () => {
  setSpinner(false);
  hideError();
  if (S.current && !P.hadPlaying) {
    P.hadPlaying = true;
    scheduleHealthCheck(S.current, S.currentMode);
    if (S.currentMode === 'live' && P.mpegts) latStart();
  }
  const tr = P.route.mode === 'transcode' ? ` · ${describeRoute(P.route)}` : '';
  setStatus((S.currentMode === 'live' ? 'In onda' : 'In riproduzione') + tr);
  updatePlayButton();
  updateTech();
});
video.addEventListener('waiting', () => {
  if (!S.current) return;
  setSpinner(true);
  if (P.hadPlaying && S.currentMode === 'live' && L.timer) latOnStall();
});
video.addEventListener('pause', () => { updatePlayButton(); if (S.current && video.readyState >= 2) setStatus('In pausa'); });
video.addEventListener('play', () => updatePlayButton());
video.addEventListener('loadedmetadata', updateTech);
video.addEventListener('volumechange', () => updateVolumeUi());
video.addEventListener('ended', () => { if (S.current && S.currentMode === 'vod') { lsDel('xp.resume.' + S.current.stream_id); setStatus('Terminato'); } });
video.addEventListener('error', async () => {
  if (!S.current) return;
  const item = S.current, mode = S.currentMode;
  const err = video.error;
  if (P.mpegts || P.hls) {
    // errore di decodifica con MSE (es. traccia che il decoder rifiuta a metà stream)
    if (!err || (err.code !== 3 && err.code !== 4)) return;
    const vB = video.webkitVideoDecodedByteCount;
    const mi = P.mediaInfo;
    // l'audio si converte solo se non è già in un formato che WebView2 legge
    const audioOk = mi && mi.audioCodec && !/^mp3/i.test(mi.audioCodec) && mseAudioOk(mi.audioCodec);
    const wanted = { v: 'copy', a: audioOk ? 'copy' : 'aac' };
    if (typeof vB === 'number' && vB === 0 && (!mi || mi.hasVideo !== false)) wanted.v = 'h264';
    if (P.route.mode === 'transcode' && P.route.a === 'aac') wanted.v = 'h264';
    if (await escalate(item, mode, wanted, 'Errore del decoder')) return;
    if (mode === 'live') onLiveError('errore del decoder'); else { destroyPlayer(); showError('Errore del decoder video/audio.'); }
    return;
  }
  if (!video.getAttribute('src')) return;
  const codes = { 1: 'riproduzione interrotta', 2: 'errore di rete', 3: 'errore di decodifica', 4: 'formato o codec non supportato' };
  const msg = err ? (codes[err.code] || 'errore sconosciuto') : 'errore sconosciuto';
  if (mode === 'live') { onLiveError(msg); return; }
  if (err && (err.code === 3 || err.code === 4)) {
    let wanted = { v: 'h264', a: 'aac' };
    if (S.caps.ffprobe) {
      setStatus('Analisi codec del file…');
      try { wanted = (await probeRoute(S.currentUrl)).route; } catch { /* conversione completa */ }
      if (S.current !== item) return;
    }
    if (await escalate(item, mode, wanted, `Il file non è riproducibile direttamente (${msg})`)) return;
  }
  showError(`Impossibile riprodurre il film nel player integrato: ${msg}. Installa ffmpeg per la conversione automatica oppure apri il film con MPV/VLC.`);
});

let lastResumeSave = 0;
video.addEventListener('timeupdate', () => {
  updateTimeUi();
  if (S.current && S.currentMode === 'vod' && video.currentTime > 0) {
    const now = Date.now();
    if (now - lastResumeSave > 5000) { lastResumeSave = now; lsSet('xp.resume.' + S.current.stream_id, Math.floor(currentPlayTime())); }
  }
});
video.addEventListener('progress', () => updateTimeUi());

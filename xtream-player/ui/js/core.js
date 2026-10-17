// Logica pura del player (nessun accesso a DOM o Tauri): caricata dalla pagina come
// script classico (window.XPCore) e dai test Node con require().
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XPCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------------ testo
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const initials = (name) => {
    const w = String(name || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    return ((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase();
  };
  const fmtTime = (sec) => {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // evidenzia i termini cercati confrontando il testo normalizzato (senza accenti, minuscolo)
  function highlight(name, terms) {
    const s = String(name || '');
    if (!terms.length) return escapeHtml(s);
    let norm = '';
    const map = [];
    for (let i = 0; i < s.length; i++) {
      const n = normKey(s[i]);
      for (let j = 0; j < n.length; j++) { norm += n[j]; map.push(i); }
    }
    const marks = new Uint8Array(s.length);
    for (const t of terms) {
      for (let p = norm.indexOf(t); p !== -1; p = norm.indexOf(t, p + t.length)) {
        for (let k = p; k < p + t.length; k++) marks[map[k]] = 1;
      }
    }
    let out = '', open = false;
    for (let i = 0; i < s.length; i++) {
      if (marks[i] && !open) { out += '<mark class="hl">'; open = true; }
      if (!marks[i] && open) { out += '</mark>'; open = false; }
      out += escapeHtml(s[i]);
    }
    return open ? out + '</mark>' : out;
  }

  // ------------------------------------------------------------------ URL
  const enc = (s) => encodeURIComponent(s);
  function buildStreamUrl(creds, item, mode, fmt) {
    const c = creds;
    if (mode === 'live') return `${c.server}/live/${enc(c.username)}/${enc(c.password)}/${item.stream_id}.${fmt}`;
    const ext = (item.container_extension || 'mp4').replace(/^\./, '');
    return `${c.server}/movie/${enc(c.username)}/${enc(c.password)}/${item.stream_id}.${ext}`;
  }
  // `opts.live`: flusso live MPEG-TS, il proxy salta la raffica iniziale del server
  function proxyUrl(proxy, url, opts) {
    if (!proxy) return url;
    return `http://127.0.0.1:${proxy.port}/p/${proxy.token}?u=${encodeURIComponent(url)}${opts && opts.live ? '&live=1' : ''}`;
  }
  function transcodeUrl(proxy, url, r, opts) {
    const q = new URLSearchParams({ u: url, v: r.v, a: r.a, live: opts.live ? '1' : '0', ss: String(Math.max(0, Math.floor(opts.ss || 0))) });
    return `http://127.0.0.1:${proxy.port}/t/${proxy.token}?${q.toString()}`;
  }

  // ------------------------------------------------------------------ codec e percorsi
  // tipo MIME con cui chiedere a MSE se un codec audio (nome mpegts.js) è supportato
  function audioMime(codec) {
    if (/^(mp3|mpeg)/i.test(codec)) return 'audio/mpeg';
    return `audio/mp4; codecs="${codec}"`;
  }
  // cosa si può copiare senza conversione nel flusso MPEG-TS letto da mpegts.js (nomi ffprobe)
  function probeVideoOk(info, caps) {
    const c = (info.video_codec || '').toLowerCase();
    // video interlacciato (tt/bb/tb/bt): WebView2 non lo decodifica, va deinterlacciato
    if (/^(tt|bb|tb|bt)$/.test(info.field_order || '')) return false;
    if (!c || c === 'h264') return true;
    if (c === 'hevc') return /10/.test(info.pix_fmt || '') ? !!caps.hevc10 : !!caps.hevc;
    return false;
  }
  function probeAudioOk(info, opusOk) {
    const c = (info.audio_codec || '').toLowerCase();
    return !c || c === 'aac' || c === 'mp3' || (c === 'opus' && !!opusOk);
  }
  function mergeRoute(a, b) {
    return { mode: 'transcode', v: (a.v === 'h264' || b.v === 'h264') ? 'h264' : 'copy', a: (a.a === 'aac' || b.a === 'aac') ? 'aac' : 'copy' };
  }
  function describeRoute(r, encoder) {
    const p = [];
    if (r.v === 'h264') p.push(`video → H.264 (${encoder || 'libx264'})`);
    if (r.a === 'aac') p.push('audio → AAC');
    return p.length ? p.join(', ') : 'remux senza conversione';
  }
  // percorso salvato per un canale: valido solo se converte qualcosa
  function normalizeSavedRoute(r) {
    return r && (r.v === 'h264' || r.a === 'aac') ? { mode: 'transcode', v: r.v === 'h264' ? 'h264' : 'copy', a: r.a === 'aac' ? 'aac' : 'copy' } : null;
  }

  // Decide cosa convertire dai metadati di mpegts.js (MEDIA_INFO) sul percorso diretto.
  // `check.videoOk(codec)` e `check.audioOk(codec)` dicono se WebView2 decodifica il codec.
  function mediaInfoRoute(mi, mode, check) {
    const wanted = { v: 'copy', a: 'copy' }, bad = [];
    if (mi.hasVideo && mi.videoCodec && !check.videoOk(mi.videoCodec)) { wanted.v = 'h264'; bad.push('video ' + mi.videoCodec); }
    if (mi.hasAudio && mi.audioCodec && !check.audioOk(mi.audioCodec)) { wanted.a = 'aac'; bad.push('audio ' + mi.audioCodec); }
    // mpegts.js etichetta come "mp3" anche l'MPEG Layer II (MP2) delle trasmissioni DVB, che
    // WebView2 non decodifica; nei live l'audio MPEG è quasi sempre MP2: si converte in AAC
    else if (mode === 'live' && mi.hasAudio && /^mp3/i.test(mi.audioCodec || '')) {
      wanted.a = 'aac'; bad.push('audio MPEG (MP2)');
      // MP2 = sorgente DVB: a 1080/576/480 righe e ≤30 fps è quasi sempre interlacciata,
      // che WebView2 non decodifica. Si converte subito anche il video (deinterlacciato a 50p)
      // invece di aspettare l'errore del decoder.
      if (mi.hasVideo && mi.fps && mi.fps <= 30.5 && [1080, 1088, 576, 480].includes(mi.height)) { wanted.v = 'h264'; bad.push('video interlacciato'); }
    }
    // traccia scartata da mpegts.js (MPEG-2 video, MP2/AC3/DTS non riconosciuti): ffmpeg la recupera
    if (mode === 'live' && mi.hasVideo === false) { wanted.v = 'h264'; bad.push('video non leggibile'); }
    if (mode === 'live' && mi.hasAudio === false) { wanted.a = 'aac'; bad.push('audio non leggibile'); }
    return { wanted, bad };
  }

  // ------------------------------------------------------------------ buffer adattivo
  // un passo del controller: salto al bordo live se troppo indietro, altrimenti velocità
  function latencyStep(ahead, target) {
    if (ahead > target + 4) return { jump: true, rate: 1 };
    let rate = 1;
    if (ahead > target + 0.25) rate = Math.min(1.15, 1 + (ahead - target) * 0.08);
    else if (ahead < target * 0.5) rate = 0.97;
    return { jump: false, rate };
  }
  // dopo uno scatto il buffer obiettivo cresce del 50% (almeno 0,4 s), fino a 8 s
  const stallTarget = (target) => Math.min(8, target + Math.max(0.4, target * 0.5));
  // dopo un periodo stabile scende di 0,15 s, mai sotto il minimo del preset
  const relaxTarget = (target, floor) => Math.max(floor, target - 0.15);

  return {
    escapeHtml, normKey, initials, fmtTime, debounce, highlight,
    buildStreamUrl, proxyUrl, transcodeUrl,
    audioMime, probeVideoOk, probeAudioOk, mergeRoute, describeRoute, normalizeSavedRoute, mediaInfoRoute,
    latencyStep, stallTarget, relaxTarget,
  };
});

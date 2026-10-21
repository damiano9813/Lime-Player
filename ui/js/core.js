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
  // mode: 'live' | 'vod' (film) | 'series' (episodio, item.stream_id = id dell'episodio)
  function buildStreamUrl(creds, item, mode, fmt) {
    const c = creds;
    if (mode === 'live') return `${c.server}/live/${enc(c.username)}/${enc(c.password)}/${item.stream_id}.${fmt}`;
    const ext = (item.container_extension || 'mp4').replace(/^\./, '');
    const kind = mode === 'series' ? 'series' : 'movie';
    return `${c.server}/${kind}/${enc(c.username)}/${enc(c.password)}/${item.stream_id}.${ext}`;
  }
  // "2026-10-17 14:10:00" (orario del server, dalla guida) -> "2026-10-17:14-10"
  function timeshiftStart(start) {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(String(start || ''));
    return m ? `${m[1]}:${m[2]}-${m[3]}` : '';
  }
  function timeshiftUrl(creds, streamId, start, durationMin) {
    const c = creds;
    return `${c.server}/timeshift/${enc(c.username)}/${enc(c.password)}/${Math.max(1, Math.ceil(durationMin))}/${timeshiftStart(start)}/${streamId}.ts`;
  }
  // `opts.live`: flusso live MPEG-TS, il proxy salta la raffica iniziale del server
  // `opts.sid`: sessione con cui il backend registra le tracce lette dalla PMT
  // `opts.keep`: secondi di raffica da tenere (il buffer con cui parte il player) o 'all'
  function proxyUrl(proxy, url, opts) {
    if (!proxy) return url;
    const o = opts || {};
    return `http://127.0.0.1:${proxy.port}/p/${proxy.token}?u=${encodeURIComponent(url)}${o.live ? '&live=1' : ''}${o.sid ? '&sid=' + enc(o.sid) : ''}${o.keep ? '&keep=' + o.keep : ''}`;
  }
  // r.at: traccia audio (-map 0:a:N); opts.q: qualità, opts.ac: 'orig' per il 5.1,
  // opts.ch: canali della traccia sorgente se noti, opts.sid: sessione per le tracce live
  function transcodeUrl(proxy, url, r, opts) {
    const q = new URLSearchParams({ u: url, v: r.v, a: r.a, live: opts.live ? '1' : '0', ss: String(Math.max(0, Math.floor(opts.ss || 0))) });
    if (r.at > 0) q.set('at', String(r.at));
    if (opts.q && opts.q !== 'bal') q.set('q', opts.q);
    if (opts.ac === 'orig') q.set('ac', 'orig');
    if (opts.ch > 0) q.set('ch', String(opts.ch));
    if (opts.sid) q.set('sid', opts.sid);
    if (opts.keep) q.set('keep', String(opts.keep));
    // film: tracce di sottotitoli estratte dallo stesso ffmpeg (servite da /s/ con lo stesso sid)
    if (opts.subs && opts.subs.length) q.set('subs', opts.subs.join(','));
    return `http://127.0.0.1:${proxy.port}/t/${proxy.token}?${q.toString()}`;
  }
  // sottotitoli testuali in WebVTT; `ss` = punto di partenza del film convertito. Con `sid` il
  // testo arriva dalla sessione /t/ in corso (nessuna connessione in più al provider)
  function subtitleUrl(proxy, url, index, ss, sid) {
    const q = new URLSearchParams({ u: url, i: String(index), ss: String(Math.max(0, Math.floor(ss || 0))) });
    if (sid) q.set('sid', sid);
    return `http://127.0.0.1:${proxy.port}/s/${proxy.token}?${q.toString()}`;
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
  // la traccia audio scelta (`at`, assente = prima traccia) resta quella del percorso attuale
  function mergeRoute(a, b) {
    const r = { mode: 'transcode', v: (a.v === 'h264' || b.v === 'h264') ? 'h264' : 'copy', a: (a.a === 'aac' || b.a === 'aac') ? 'aac' : 'copy' };
    const at = a.at > 0 ? a.at : b.at > 0 ? b.at : 0;
    if (at) r.at = at;
    return r;
  }
  function describeRoute(r, encoder) {
    const p = [];
    if (r.v === 'h264') p.push(`video → H.264 (${encoder || 'libx264'})`);
    if (r.a === 'aac') p.push('audio → AAC');
    return p.length ? p.join(', ') : 'remux senza conversione';
  }
  // percorso salvato per un canale: valido solo se converte qualcosa o sceglie un'altra traccia audio
  function normalizeSavedRoute(r) {
    const at = r && Number.isInteger(r.at) && r.at > 0 && r.at < 64 ? r.at : 0;
    if (!r || !(r.v === 'h264' || r.a === 'aac' || at)) return null;
    const out = { mode: 'transcode', v: r.v === 'h264' ? 'h264' : 'copy', a: r.a === 'aac' ? 'aac' : 'copy' };
    if (at) out.at = at;
    return out;
  }

  // ------------------------------------------------------------------ tracce e lingue
  // codici ISO 639-1 e 639-2/B → 639-2/T (quello usato qui come forma canonica)
  const LANG_ALIAS = {
    it: 'ita', en: 'eng', es: 'spa', fr: 'fra', fre: 'fra', de: 'deu', ger: 'deu', pt: 'por', nl: 'nld', dut: 'nld',
    pl: 'pol', ro: 'ron', rum: 'ron', ru: 'rus', tr: 'tur', ar: 'ara', sq: 'sqi', alb: 'sqi', hr: 'hrv', sr: 'srp',
    el: 'ell', gre: 'ell', ja: 'jpn', ko: 'kor', zh: 'zho', chi: 'zho', cs: 'ces', cze: 'ces', hu: 'hun', sv: 'swe',
    no: 'nor', nb: 'nor', da: 'dan', fi: 'fin', uk: 'ukr', bg: 'bul', sk: 'slk', slo: 'slk', sl: 'slv', he: 'heb',
    ca: 'cat', hi: 'hin', fa: 'fas', per: 'fas', bs: 'bos', mk: 'mkd', mac: 'mkd', ku: 'kur', ur: 'urd', ta: 'tam',
  };
  const LANG_NAMES = {
    ita: 'Italiano', eng: 'Inglese', spa: 'Spagnolo', fra: 'Francese', deu: 'Tedesco', por: 'Portoghese', nld: 'Olandese',
    pol: 'Polacco', ron: 'Rumeno', rus: 'Russo', tur: 'Turco', ara: 'Arabo', sqi: 'Albanese', hrv: 'Croato', srp: 'Serbo',
    ell: 'Greco', jpn: 'Giapponese', kor: 'Coreano', zho: 'Cinese', ces: 'Ceco', hun: 'Ungherese', swe: 'Svedese',
    nor: 'Norvegese', dan: 'Danese', fin: 'Finlandese', ukr: 'Ucraino', bul: 'Bulgaro', slk: 'Slovacco', slv: 'Sloveno',
    heb: 'Ebraico', cat: 'Catalano', hin: 'Hindi', fas: 'Persiano', bos: 'Bosniaco', mkd: 'Macedone', kur: 'Curdo',
    urd: 'Urdu', tam: 'Tamil', lat: 'Latino', mul: 'Più lingue', qaa: 'Lingua originale', mis: 'Altra lingua',
  };
  // lingue proposte nelle impostazioni (preferenza audio e sottotitoli)
  const PREFERRED_LANGS = ['ita', 'eng', 'spa', 'fra', 'deu', 'por', 'nld', 'pol', 'ron', 'rus', 'tur', 'ara', 'sqi', 'ell', 'jpn'];
  // "it-IT", "ITA", "ger" → "ita", "ita", "deu"; vuoto per und/zxx o codici non validi
  function normLang(code) {
    const c = String(code || '').trim().toLowerCase().split(/[-_]/)[0];
    if (!/^[a-z]{2,3}$/.test(c) || c === 'und' || c === 'zxx') return '';
    return LANG_ALIAS[c] || c;
  }
  function langName(code) {
    const c = normLang(code);
    return c ? LANG_NAMES[c] || c.toUpperCase() : 'Lingua non indicata';
  }
  const CODEC_NAMES = {
    aac: 'AAC', aac_latm: 'AAC LATM', mp2: 'MP2', mp3: 'MP3', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', dts: 'DTS',
    truehd: 'Dolby TrueHD', opus: 'Opus', flac: 'FLAC', vorbis: 'Vorbis', subrip: 'SRT', srt: 'SRT', ass: 'ASS', ssa: 'SSA',
    mov_text: 'Testo MP4', webvtt: 'WebVTT', dvb_subtitle: 'DVB', dvb_teletext: 'Televideo', hdmv_pgs_subtitle: 'PGS',
    dvd_subtitle: 'DVD',
  };
  const codecName = (c) => CODEC_NAMES[c] || (c ? String(c).toUpperCase() : '');
  function channelsLabel(n) {
    n = Number(n) || 0;
    return n === 1 ? 'mono' : n === 2 ? 'stereo' : n === 6 ? '5.1' : n === 8 ? '7.1' : n > 0 ? `${n} canali` : '';
  }
  // "Italiano · Dolby Digital 5.1 · Commento" (i titoli uguali alla lingua non si ripetono)
  function trackLabel(t) {
    const name = langName(t.lang);
    const tech = [codecName(t.codec), channelsLabel(t.channels)].filter(Boolean).join(' ');
    const title = t.title && t.title.toLowerCase() !== name.toLowerCase() ? t.title : '';
    return [name, tech, title, t.forced ? 'forzati' : ''].filter(Boolean).join(' · ');
  }
  // indice (nell'elenco) della traccia nella lingua preferita: prima quella predefinita, poi la prima;
  // -1 se non c'è preferenza o nessuna traccia corrisponde; `textOnly`: solo sottotitoli testuali
  function pickTrack(tracks, pref, textOnly) {
    const p = normLang(pref);
    if (!p || !tracks) return -1;
    const match = tracks.map((t, i) => [t, i]).filter(([t]) => normLang(t.lang) === p && (!textOnly || t.text));
    if (!match.length) return -1;
    const def = match.find(([t]) => t.default && !t.forced);
    const plain = match.find(([t]) => !t.forced);
    return (def || plain || match[0])[1];
  }
  // audio che mpegts.js/WebView2 riproduce senza conversione (nomi ffmpeg)
  const audioCopyOk = (codec, opusOk) => { const c = String(codec || '').toLowerCase(); return c === 'aac' || c === 'mp3' || (c === 'opus' && !!opusOk); };
  // Percorso per ascoltare la traccia audio `track` (con il suo indice `index` tra le tracce audio).
  // La prima traccia con audio compatibile resta sul percorso diretto, se lo era già.
  function audioTrackRoute(current, track, opts) {
    const o = opts || {};
    const a = audioCopyOk(track.codec, o.opusOk) ? 'copy' : 'aac';
    const v = current && current.v === 'h264' ? 'h264' : 'copy';
    if (track.index === 0 && a === 'copy' && v === 'copy' && current && current.mode === 'direct' && !o.forceTranscode) {
      return { mode: 'direct', v: 'copy', a: 'copy' };
    }
    const r = { mode: 'transcode', v, a };
    if (track.index > 0) r.at = track.index;
    return r;
  }

  // ------------------------------------------------------------------ impostazioni
  const SETTINGS_DEFAULTS = { audioOut: 'stereo', quality: 'bal', audioLang: '', subLang: '', external: 'auto', engine: 'mpv' };
  function normalizeSettings(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);
    return {
      audioOut: pick(r.audioOut, ['stereo', 'orig'], 'stereo'),
      quality: pick(r.quality, ['fast', 'bal', 'high'], 'bal'),
      audioLang: normLang(r.audioLang),
      subLang: normLang(r.subLang),
      external: pick(r.external, ['auto', 'mpv', 'vlc'], 'auto'),
      // motore integrato: mpv (libmpv in una finestra nativa) o quello del browser (mpegts.js/MSE)
      engine: pick(r.engine, ['mpv', 'web'], 'mpv'),
    };
  }

  // ------------------------------------------------------------------ motore mpv
  // `track-list` di mpv (JSON) nel formato delle tracce del player: `index` è l'id di mpv.
  // mpv mostra anche i sottotitoli a immagine, quindi sono tutti selezionabili (`text`).
  function mpvTracks(list) {
    const out = { audio: [], subs: [], aid: 0, sid: 0 };
    for (const t of Array.isArray(list) ? list : []) {
      if (!t || (t.type !== 'audio' && t.type !== 'sub')) continue;
      const track = {
        index: Number(t.id) || 0, lang: t.lang || '', codec: t.codec || '', title: t.title || '',
        default: !!t.default, forced: !!t.forced,
      };
      if (t.type === 'audio') {
        track.channels = Number(t['demux-channel-count']) || 0;
        out.audio.push(track);
        if (t.selected) out.aid = track.index;
      } else {
        track.text = true;
        out.subs.push(track);
        if (t.selected) out.sid = track.index;
      }
    }
    return out;
  }
  // secondi di cache del live per i preset di latenza: "Stabile" tiene più margine
  function mpvCacheSecs(preset) {
    return preset === 'min' ? 1 : preset === 'bal' ? 2 : 4;
  }

  // Conversione decisa dalla PMT del live (tracce lette dal proxy nei primi millisecondi),
  // prima che i dati arrivino al player: evita di partire in diretta e ripartire con ffmpeg.
  // L'audio MP2 da solo resta a mediaInfoRoute, che dalla risoluzione capisce se il video
  // DVB è interlacciato e va convertito insieme all'audio.
  function pmtRoute(tracks, caps) {
    const c = caps || {};
    const video = (tracks || []).find((t) => t.kind === 'video');
    const audio = (tracks || []).find((t) => t.kind === 'audio');
    const wanted = { v: 'copy', a: 'copy' }, bad = [];
    const vc = video ? video.codec : '';
    if (['mpeg2video', 'mpeg4', 'vc1'].includes(vc) || (vc === 'hevc' && !c.hevc)) { wanted.v = 'h264'; bad.push('video ' + vc); }
    const ac = audio ? audio.codec : '';
    // aac_latm lo converte già mpegts.js
    const audioOk = !ac || ac === 'aac_latm' || audioCopyOk(ac, c.opus);
    if (!audioOk && (ac !== 'mp2' || wanted.v === 'h264')) { wanted.a = 'aac'; bad.push('audio ' + ac); }
    return { wanted, bad };
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
  // `chase` falso (preset "Stabile", partito dalla raffica): il ritardo dalla diretta resta
  // quello che è, si rallenta solo se il buffer cala e si salta solo oltre 90 s di ritardo
  function latencyStep(ahead, target, chase) {
    if (chase === false) return { jump: ahead > 90, rate: ahead < target * 0.5 ? 0.97 : 1 };
    if (ahead > target + 4) return { jump: true, rate: 1 };
    let rate = 1;
    if (ahead > target + 0.25) rate = Math.min(1.15, 1 + (ahead - target) * 0.08);
    else if (ahead < target * 0.5) rate = 0.97;
    return { jump: false, rate };
  }
  // dopo uno scatto il buffer obiettivo cresce del 50% (almeno 0,4 s), fino a 8 s
  const stallTarget = (target) => Math.min(8, target + Math.max(0.4, target * 0.5));
  // il margine aggiunto da uno scatto si riduce di 0,25 s a ogni passo senza altri scatti
  const relaxBoost = (boost) => Math.max(0, boost - 0.25);

  // Buffer misurato. Campioni [istante, fine del buffer] in secondi: se il provider mandasse i
  // dati perfettamente in tempo reale, la fine del buffer avanzerebbe di 1 s al secondo e
  // (fine - istante) resterebbe costante. Il calo massimo di quel valore tra due campioni è il
  // buffer che la pausa peggiore del provider avrebbe consumato.
  function arrivalDrawdown(samples) {
    let peak = -Infinity, worst = 0;
    for (const [w, e] of samples || []) {
      const d = e - w;
      if (d > peak) peak = d;
      else if (peak - d > worst) worst = peak - d;
    }
    return worst;
  }
  // buffer che regge la pausa peggiore misurata, con un quarto di margine più 0,4 s (max 8 s)
  const measuredTarget = (drawdown) => Math.min(8, Math.max(0, drawdown) * 1.25 + 0.4);
  // secondi della raffica iniziale che il proxy lascia al player: il buffer obiettivo più un
  // margine, così si parte subito con il buffer pieno invece di riempirlo guardando (1-10 s)
  const burstKeep = (target) => Math.min(10, Math.max(1, Math.round((target + 1) * 10) / 10));
  // Buco nella timeline (discontinuità dei timestamp, dati persi in una riconnessione): il
  // video si fermerebbe sul bordo. `ranges` = [[inizio, fine], ...] del buffer; restituisce il
  // punto da cui ripartire se il buco è entro `maxGap` secondi, altrimenti -1.
  function gapJump(ranges, t, maxGap) {
    const cur = (ranges || []).find(([s, e]) => t >= s - 0.05 && t < e);
    if (cur && cur[1] - t > 0.3) return -1;
    const next = (ranges || []).find(([s]) => s > t + 0.01);
    if (!next || next[0] - t > (maxGap || 30)) return -1;
    return next[0] + 0.05;
  }
  // buffer da riavere prima di ripartire dopo uno scatto: ripartire con pochi fotogrammi
  // darebbe una serie di micro-scatti
  const rebufferNeed = (target) => Math.min(4, Math.max(0.8, target * 0.75));

  // ------------------------------------------------------------------ guida TV e serie
  // programma in onda e successivo (orari in secondi Unix)
  function currentAndNext(entries, now) {
    const list = (entries || []).filter((e) => e.end_ts > now).sort((a, b) => a.start_ts - b.start_ts);
    const cur = list.find((e) => e.start_ts <= now && e.end_ts > now) || null;
    const next = list.find((e) => e.start_ts >= (cur ? cur.end_ts : now)) || null;
    return { now: cur, next };
  }
  const epgProgress = (e, now) => (e && e.end_ts > e.start_ts ? Math.min(1, Math.max(0, (now - e.start_ts) / (e.end_ts - e.start_ts))) : 0);
  // programmi già finiti ancora nell'archivio del canale (tv_archive_duration giorni), dal più recente
  function archivedPrograms(entries, now, days) {
    const from = now - Math.max(0, Number(days) || 0) * 86400;
    return (entries || []).filter((e) => e.end_ts <= now && e.start_ts >= from).sort((a, b) => b.start_ts - a.start_ts);
  }
  // ------------------------------------------------------------------ griglia della guida
  // giorni della griglia, da mezzanotte a mezzanotte locali (23 o 25 ore nei cambi d'ora):
  // da `past` giorni fa a `future` giorni avanti; `offset` 0 = oggi
  function guideDays(now, past, future) {
    const d = new Date(now * 1000);
    const out = [];
    for (let o = -Math.max(0, past | 0); o <= Math.max(0, future | 0); o++) {
      const a = new Date(d.getFullYear(), d.getMonth(), d.getDate() + o);
      const b = new Date(d.getFullYear(), d.getMonth(), d.getDate() + o + 1);
      const label = o === 0 ? 'Oggi' : o === -1 ? 'Ieri' : o === 1 ? 'Domani'
        : a.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric' });
      out.push({ offset: o, from: a.getTime() / 1000, to: b.getTime() / 1000, label });
    }
    return out;
  }
  // giorni di archivio da proporre: il massimo tra i canali con catch-up (1–7)
  function guidePastDays(channels) {
    let max = 0;
    for (const c of channels || []) if (String(c.tv_archive) === '1') max = Math.max(max, Number(c.tv_archive_duration) || 3);
    return Math.min(7, Math.max(1, max));
  }
  // blocchi di una riga dentro [from, to): x e larghezza in px; un programma che si
  // sovrappone al precedente parte dalla sua fine, quelli rimasti senza durata spariscono
  function layoutPrograms(entries, from, to, pxPerSec) {
    const list = (entries || []).filter((e) => e.end_ts > from && e.start_ts < to).sort((a, b) => a.start_ts - b.start_ts);
    const out = [];
    let cursor = from;
    for (const e of list) {
      const s = Math.max(e.start_ts, cursor), en = Math.min(e.end_ts, to);
      if (en <= s) continue;
      out.push({ e, x: (s - from) * pxPerSec, w: (en - s) * pxPerSec });
      cursor = en;
    }
    return out;
  }
  // 'live' in onda, 'archive' passato e rivedibile (catch-up), 'past', 'future'
  function programState(e, now, channel) {
    if (e.start_ts <= now && e.end_ts > now) return 'live';
    if (e.start_ts > now) return 'future';
    const c = channel || {};
    const days = Number(c.tv_archive_duration) || 3;
    const inArchive = String(c.tv_archive) === '1' && e.start_ts >= now - days * 86400;
    return inArchive || e.has_archive ? 'archive' : 'past';
  }
  // istanti delle tacche dell'asse orario (ogni `step` secondi da `from`)
  function timeTicks(from, to, step) {
    const out = [];
    for (let t = from; t < to; t += step) out.push(t);
    return out;
  }
  // righe da disegnare per uno scroll verticale (fine esclusa)
  function visibleRows(scrollTop, viewH, rowH, total, overscan) {
    const first = Math.floor(Math.max(0, scrollTop) / rowH);
    const start = Math.max(0, first - overscan);
    const end = Math.min(total, first + Math.ceil(viewH / rowH) + 1 + overscan);
    return { start, end: Math.max(start, end) };
  }
  // voce della guida per canale (orario del server per il catch-up) più vicina a un
  // programma della guida completa: stesso inizio entro `tol` secondi
  function matchProgram(entries, startTs, tol) {
    const t = tol == null ? 120 : tol;
    let best = null;
    for (const e of entries || []) {
      const d = Math.abs(e.start_ts - startTs);
      if (d <= t && (!best || d < Math.abs(best.start_ts - startTs))) best = e;
    }
    return best;
  }

  const hasCodecs = (c) => !!(c && (c.video_codec || c.audio_codec));
  const episodeLabel = (e) => `S${String(e.season).padStart(2, '0')}E${String(e.episode_num).padStart(2, '0')}`;
  function nextEpisode(episodes, currentId) {
    const i = (episodes || []).findIndex((e) => String(e.id) === String(currentId));
    return i === -1 ? null : episodes[i + 1] || null;
  }

  // ------------------------------------------------------------------ credenziali
  // in localStorage solo server e utente: la password sta in Gestione credenziali (Rust)
  const publicCreds = (c) => (c && c.server && c.username ? { server: String(c.server), username: String(c.username) } : null);

  // ------------------------------------------------------------------ dati per account
  // Preferiti, recenti, categoria scelta, posizioni di ripresa e percorsi per canale usano gli id
  // del provider: stanno sotto "xp.a.<account>." perché su un altro account indicano altri contenuti.
  // id breve e stabile dell'account: FNV-1a a 32 bit di server normalizzato e utente
  function accountId(server, username) {
    const s = String(server || '') + '\n' + String(username || '').trim();
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  const accountKey = (acct, key) => `xp.a.${acct}.${key}`;
  // chiavi delle versioni precedenti, senza account
  const LEGACY_KEY_RE = /^xp\.((?:fav|recent|cat)\.(?:live|vod|series)|(?:resume|route|series\.last)\..+)$/;
  // [vecchia chiave, nuova chiave] per spostare i dati senza account sull'account `acct`
  function legacyKeyMoves(keys, acct) {
    return (keys || []).map((k) => LEGACY_KEY_RE.exec(k)).filter(Boolean).map((m) => [m[0], accountKey(acct, m[1])]);
  }
  // posizione di ripresa: { p: secondi, t: data del salvataggio } (prima solo i secondi)
  function resumeSeconds(v) {
    const p = v && typeof v === 'object' ? v.p : v;
    return typeof p === 'number' && isFinite(p) && p > 0 ? p : 0;
  }
  // valore spostato dalla migrazione: le vecchie posizioni non hanno data, prendono quella di oggi
  function migratedValue(key, value, now) {
    return /^xp\.resume\./.test(key) && typeof value === 'number' ? { p: value, t: now } : value;
  }
  // voci che crescono con ogni film o canale aperto: 'resume' | 'route' | '' (da non potare)
  function prunableKind(key) {
    const m = /^xp\.a\.[0-9a-f]{8}\.(resume|route)\./.exec(key);
    return m ? m[1] : '';
  }
  // voci da cancellare: più vecchie di `maxAgeMs` (o senza data) e, oltre `maxCount`, le meno recenti
  function staleEntries(entries, now, limits) {
    const fresh = [], stale = [];
    for (const e of entries || []) (e.t > 0 && now - e.t <= limits.maxAgeMs ? fresh : stale).push(e);
    fresh.sort((a, b) => b.t - a.t);
    return stale.concat(fresh.slice(limits.maxCount)).map((e) => e.key);
  }

  return {
    publicCreds, accountId, accountKey, legacyKeyMoves, resumeSeconds, migratedValue, prunableKind, staleEntries,
    escapeHtml, normKey, initials, fmtTime, debounce, highlight,
    buildStreamUrl, proxyUrl, transcodeUrl, subtitleUrl, timeshiftStart, timeshiftUrl,
    normLang, langName, codecName, channelsLabel, trackLabel, pickTrack, audioCopyOk, audioTrackRoute, PREFERRED_LANGS,
    SETTINGS_DEFAULTS, normalizeSettings, pmtRoute, mpvTracks, mpvCacheSecs,
    currentAndNext, epgProgress, archivedPrograms, hasCodecs, episodeLabel, nextEpisode,
    guideDays, guidePastDays, layoutPrograms, programState, timeTicks, visibleRows, matchProgram,
    audioMime, probeVideoOk, probeAudioOk, mergeRoute, describeRoute, normalizeSavedRoute, mediaInfoRoute,
    latencyStep, stallTarget, relaxBoost, arrivalDrawdown, measuredTarget, burstKeep, gapJump, rebufferNeed,
  };
});

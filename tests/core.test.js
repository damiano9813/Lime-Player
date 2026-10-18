// Test della logica pura del player (ui/js/core.js): `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../ui/js/core.js');

test('testo: escape, normalizzazione, iniziali, tempo', () => {
  assert.equal(X.escapeHtml('<a href="x">\'&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(X.escapeHtml(null), '');
  assert.equal(X.normKey('Èlite TV Città'), 'elite tv citta');
  assert.equal(X.initials('ES: DAZN LA LIGA'), 'ED');
  assert.equal(X.initials('  '), '?');
  assert.equal(X.fmtTime(5), '0:05');
  assert.equal(X.fmtTime(65), '1:05');
  assert.equal(X.fmtTime(3725), '1:02:05');
  assert.equal(X.fmtTime(NaN), '0:00');
  assert.equal(X.fmtTime(-3), '0:00');
});

test('credenziali pubbliche: niente password in localStorage', () => {
  assert.deepEqual(X.publicCreds({ server: 'http://h', username: 'u', password: 'p' }), { server: 'http://h', username: 'u' });
  assert.equal(X.publicCreds({ server: 'http://h' }), null);
  assert.equal(X.publicCreds(null), null);
  assert.equal(JSON.stringify(X.publicCreds({ server: 's', username: 'u', password: 'segreta' })).includes('segreta'), false);
});

test('highlight ignora accenti e maiuscole e fa l\'escape', () => {
  assert.equal(X.highlight('Città <b>', []), 'Città &lt;b&gt;');
  assert.equal(X.highlight('Città Sport', ['citta']), '<mark class="hl">Città</mark> Sport');
  assert.equal(X.highlight('DAZN LA LIGA 2', ['liga', 'dazn']), '<mark class="hl">DAZN</mark> LA <mark class="hl">LIGA</mark> 2');
  assert.equal(X.highlight('abc', ['c']), 'ab<mark class="hl">c</mark>');
});

test('debounce esegue solo l\'ultima chiamata', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const f = X.debounce((v) => calls.push(v), 100);
  f(1); f(2);
  t.mock.timers.tick(99);
  assert.deepEqual(calls, []);
  f(3);
  t.mock.timers.tick(100);
  assert.deepEqual(calls, [3]);
});

test('URL degli stream con credenziali codificate', () => {
  const creds = { server: 'http://h:8080', username: 'mario@x', password: 'p#ss/1' };
  assert.equal(X.buildStreamUrl(creds, { stream_id: '839972' }, 'live', 'ts'), 'http://h:8080/live/mario%40x/p%23ss%2F1/839972.ts');
  assert.equal(X.buildStreamUrl(creds, { stream_id: '5', container_extension: '.mkv' }, 'vod'), 'http://h:8080/movie/mario%40x/p%23ss%2F1/5.mkv');
  assert.equal(X.buildStreamUrl(creds, { stream_id: '5' }, 'vod'), 'http://h:8080/movie/mario%40x/p%23ss%2F1/5.mp4');
});

test('URL degli episodi e del catch-up', () => {
  const creds = { server: 'http://h:8080', username: 'u', password: 'p@1' };
  assert.equal(X.buildStreamUrl(creds, { stream_id: '2139117', container_extension: 'mkv' }, 'series'), 'http://h:8080/series/u/p%401/2139117.mkv');
  assert.equal(X.timeshiftStart('2026-10-17 14:10:00'), '2026-10-17:14-10');
  assert.equal(X.timeshiftStart('2026-10-17T09:05:00'), '2026-10-17:09-05');
  assert.equal(X.timeshiftStart('ieri'), '');
  assert.equal(X.timeshiftUrl(creds, '497001', '2026-10-17 14:10:00', 4.2), 'http://h:8080/timeshift/u/p%401/5/2026-10-17:14-10/497001.ts');
});

test('guida TV: in onda, successivo, avanzamento, archivio', () => {
  const e = [
    { title: 'C', start_ts: 300, end_ts: 400 },
    { title: 'A', start_ts: 100, end_ts: 200 },
    { title: 'B', start_ts: 200, end_ts: 300 },
  ];
  assert.deepEqual(X.currentAndNext(e, 250), { now: e[2], next: e[0] });
  assert.deepEqual(X.currentAndNext(e, 50), { now: null, next: e[1] }, 'prima dell\'inizio');
  assert.deepEqual(X.currentAndNext(e, 500), { now: null, next: null });
  assert.deepEqual(X.currentAndNext([], 1), { now: null, next: null });
  assert.equal(X.epgProgress(e[2], 250), 0.5);
  assert.equal(X.epgProgress(e[2], 999), 1);
  assert.equal(X.epgProgress(null, 1), 0);
  const day = 86400, now = 10 * day;
  const arch = [
    { title: 'vecchio', start_ts: now - 5 * day, end_ts: now - 5 * day + 60 },
    { title: 'ieri', start_ts: now - day, end_ts: now - day + 60 },
    { title: 'oggi', start_ts: now - 600, end_ts: now - 60 },
    { title: 'in onda', start_ts: now - 30, end_ts: now + 30 },
  ];
  assert.deepEqual(X.archivedPrograms(arch, now, 3).map((p) => p.title), ['oggi', 'ieri']);
  assert.deepEqual(X.archivedPrograms(arch, now, 0), []);
});

test('serie: codec dichiarati, etichette, episodio successivo', () => {
  assert.equal(X.hasCodecs({ video_codec: 'hevc', audio_codec: '' }), true);
  assert.equal(X.hasCodecs({ video_codec: '', audio_codec: '' }), false);
  assert.equal(X.hasCodecs(null), false);
  assert.equal(X.episodeLabel({ season: 1, episode_num: 2 }), 'S01E02');
  const eps = [{ id: '11' }, { id: '12' }, { id: 21 }];
  assert.deepEqual(X.nextEpisode(eps, 12), { id: 21 });
  assert.equal(X.nextEpisode(eps, '21'), null);
  assert.equal(X.nextEpisode(eps, 'x'), null);
});

test('URL del proxy locale', () => {
  const proxy = { port: 5555, token: 'tok' };
  const src = 'http://h/live/a/b/1.ts?x=1&y=2';
  assert.equal(X.proxyUrl(null, src), src);
  const p = new URL(X.proxyUrl(proxy, src));
  assert.equal(p.host, '127.0.0.1:5555');
  assert.equal(p.pathname, '/p/tok');
  assert.equal(p.searchParams.get('u'), src);
  assert.equal(p.searchParams.get('live'), null);
  const pl = new URL(X.proxyUrl(proxy, src, { live: true }));
  assert.equal(pl.searchParams.get('u'), src, 'il parametro live non altera l\'URL originale');
  assert.equal(pl.searchParams.get('live'), '1');

  const t = new URL(X.transcodeUrl(proxy, src, { v: 'h264', a: 'aac' }, { live: false, ss: 125.9 }));
  assert.equal(t.pathname, '/t/tok');
  assert.equal(t.searchParams.get('u'), src);
  assert.equal(t.searchParams.get('v'), 'h264');
  assert.equal(t.searchParams.get('a'), 'aac');
  assert.equal(t.searchParams.get('live'), '0');
  assert.equal(t.searchParams.get('ss'), '125');
  const live = new URL(X.transcodeUrl(proxy, src, { v: 'copy', a: 'aac' }, { live: true }));
  assert.equal(live.searchParams.get('live'), '1');
  assert.equal(live.searchParams.get('ss'), '0');
});

test('percorsi di conversione', () => {
  assert.deepEqual(X.mergeRoute({ v: 'copy', a: 'aac' }, { v: 'h264', a: 'copy' }), { mode: 'transcode', v: 'h264', a: 'aac' });
  assert.deepEqual(X.mergeRoute({ v: 'copy', a: 'copy' }, { v: 'copy', a: 'copy' }), { mode: 'transcode', v: 'copy', a: 'copy' });
  assert.equal(X.describeRoute({ v: 'h264', a: 'aac' }, 'h264_nvenc'), 'video → H.264 (h264_nvenc), audio → AAC');
  assert.equal(X.describeRoute({ v: 'h264', a: 'copy' }), 'video → H.264 (libx264)');
  assert.equal(X.describeRoute({ v: 'copy', a: 'copy' }), 'remux senza conversione');
  assert.deepEqual(X.normalizeSavedRoute({ v: 'h264', a: 'aac', t: 1 }), { mode: 'transcode', v: 'h264', a: 'aac' });
  assert.deepEqual(X.normalizeSavedRoute({ v: 'strano', a: 'aac' }), { mode: 'transcode', v: 'copy', a: 'aac' });
  assert.equal(X.normalizeSavedRoute({ v: 'copy', a: 'copy' }), null);
  assert.equal(X.normalizeSavedRoute(null), null);
});

test('decisioni da ffprobe (film e catch-up)', () => {
  const caps = { hevc: true, hevc10: false };
  assert.equal(X.probeVideoOk({ video_codec: 'h264', field_order: 'progressive' }, caps), true);
  assert.equal(X.probeVideoOk({ video_codec: 'h264', field_order: 'tt' }, caps), false, 'interlacciato');
  assert.equal(X.probeVideoOk({ video_codec: 'hevc', pix_fmt: 'yuv420p' }, caps), true);
  assert.equal(X.probeVideoOk({ video_codec: 'hevc', pix_fmt: 'yuv420p10le' }, caps), false);
  assert.equal(X.probeVideoOk({ video_codec: 'mpeg2video' }, caps), false);
  assert.equal(X.probeVideoOk({}, caps), true, 'senza video');
  assert.equal(X.probeAudioOk({ audio_codec: 'AAC' }), true);
  assert.equal(X.probeAudioOk({ audio_codec: 'ac3' }), false);
  assert.equal(X.probeAudioOk({ audio_codec: 'mp2' }), false);
  assert.equal(X.probeAudioOk({ audio_codec: 'opus' }, false), false);
  assert.equal(X.probeAudioOk({ audio_codec: 'opus' }, true), true);
  assert.equal(X.audioMime('mp3'), 'audio/mpeg');
  assert.equal(X.audioMime('ac-3'), 'audio/mp4; codecs="ac-3"');
});

// codec che WebView2 decodifica (come misurato su questo PC)
const webview2 = {
  videoOk: (c) => /^avc1/.test(c),
  audioOk: (c) => /^mp4a|^mp3|^opus/.test(c),
};

test('MEDIA_INFO: canale DVB con MP2 e 1080i (caso DAZN LA LIGA)', () => {
  const mi = { hasVideo: true, hasAudio: true, videoCodec: 'avc1.640028', audioCodec: 'mp3', fps: 25, width: 1920, height: 1080 };
  const { wanted, bad } = X.mediaInfoRoute(mi, 'live', webview2);
  assert.deepEqual(wanted, { v: 'h264', a: 'aac' });
  assert.deepEqual(bad, ['audio MPEG (MP2)', 'video interlacciato']);
});

test('MEDIA_INFO: MP2 con 720p50 converte solo l\'audio', () => {
  const mi = { hasVideo: true, hasAudio: true, videoCodec: 'avc1.64001f', audioCodec: 'mp3', fps: 50, height: 720 };
  assert.deepEqual(X.mediaInfoRoute(mi, 'live', webview2).wanted, { v: 'copy', a: 'aac' });
});

test('MEDIA_INFO: H.264 + AAC resta diretto', () => {
  const mi = { hasVideo: true, hasAudio: true, videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2', fps: 25, height: 1080 };
  const r = X.mediaInfoRoute(mi, 'live', webview2);
  assert.deepEqual(r.wanted, { v: 'copy', a: 'copy' });
  assert.deepEqual(r.bad, []);
});

test('MEDIA_INFO: AC3 e HEVC non supportati', () => {
  const mi = { hasVideo: true, hasAudio: true, videoCodec: 'hvc1.1.6.L120.90', audioCodec: 'ac-3' };
  const r = X.mediaInfoRoute(mi, 'live', webview2);
  assert.deepEqual(r.wanted, { v: 'h264', a: 'aac' });
  assert.deepEqual(r.bad, ['video hvc1.1.6.L120.90', 'audio ac-3']);
});

test('MEDIA_INFO: tracce scartate da mpegts.js nei live', () => {
  assert.deepEqual(X.mediaInfoRoute({ hasVideo: false, hasAudio: true, audioCodec: 'mp4a.40.2' }, 'live', webview2).wanted, { v: 'h264', a: 'copy' });
  assert.deepEqual(X.mediaInfoRoute({ hasVideo: true, hasAudio: false, videoCodec: 'avc1.64001f' }, 'live', webview2).wanted, { v: 'copy', a: 'aac' });
});

test('MEDIA_INFO: nei film l\'audio MPEG non viene forzato', () => {
  const mi = { hasVideo: true, hasAudio: true, videoCodec: 'avc1.640028', audioCodec: 'mp3', fps: 25, height: 1080 };
  assert.deepEqual(X.mediaInfoRoute(mi, 'vod', webview2).wanted, { v: 'copy', a: 'copy' });
});

test('buffer adattivo: passo del controller', () => {
  assert.deepEqual(X.latencyStep(1.0, 1.0), { jump: false, rate: 1 });
  assert.deepEqual(X.latencyStep(6, 1.0), { jump: true, rate: 1 }, 'troppo indietro: salto');
  assert.equal(X.latencyStep(5, 1.0).jump, false, 'al limite si recupera con la velocità');
  assert.ok(Math.abs(X.latencyStep(2.0, 1.0).rate - 1.08) < 1e-9);
  assert.equal(X.latencyStep(4.5, 1.0).rate, 1.15, 'velocità massima 1,15×');
  assert.equal(X.latencyStep(0.4, 1.0).rate, 0.97, 'buffer basso: si rallenta');
  assert.equal(X.latencyStep(0.8, 1.0).rate, 1, 'banda morta');
});

test('buffer adattivo: crescita dopo scatto e rilascio', () => {
  assert.equal(X.stallTarget(0.6), 1.0);
  assert.equal(X.stallTarget(2), 3);
  assert.equal(X.stallTarget(7), 8);
  assert.ok(Math.abs(X.relaxTarget(1.0, 0.6) - 0.85) < 1e-9);
  assert.equal(X.relaxTarget(0.65, 0.6), 0.6);
});

test('URL con traccia audio, qualità, 5.1, sessione e sottotitoli', () => {
  const proxy = { port: 5555, token: 'tok' };
  const src = 'http://h/live/a/b/1.ts';
  const pl = new URL(X.proxyUrl(proxy, src, { live: true, sid: 'ab c' }));
  assert.equal(pl.searchParams.get('sid'), 'ab c');
  assert.equal(pl.searchParams.get('u'), src);
  const t = new URL(X.transcodeUrl(proxy, src, { v: 'copy', a: 'aac', at: 2 }, { live: true, q: 'high', ac: 'orig', ch: 6, sid: 's1' }));
  assert.equal(t.searchParams.get('at'), '2');
  assert.equal(t.searchParams.get('q'), 'high');
  assert.equal(t.searchParams.get('ac'), 'orig');
  assert.equal(t.searchParams.get('ch'), '6');
  assert.equal(t.searchParams.get('sid'), 's1');
  // valori predefiniti: URL corti, nessun parametro superfluo
  const d = new URL(X.transcodeUrl(proxy, src, { v: 'copy', a: 'aac' }, { live: true, q: 'bal', ac: 'stereo', ch: 0 }));
  for (const k of ['at', 'q', 'ac', 'ch', 'sid']) assert.equal(d.searchParams.get(k), null, k);
  const s = new URL(X.subtitleUrl(proxy, 'http://h/movie/u/p/7.mkv', 1, 754.8));
  assert.equal(s.pathname, '/s/tok');
  assert.equal(s.searchParams.get('u'), 'http://h/movie/u/p/7.mkv');
  assert.equal(s.searchParams.get('i'), '1');
  assert.equal(s.searchParams.get('ss'), '754', 'stesso arrotondamento del percorso /t/');
  assert.equal(new URL(X.subtitleUrl(proxy, 'http://h/1.mp4', 0)).searchParams.get('ss'), '0');
  assert.equal(new URL(X.subtitleUrl(proxy, 'http://h/1.mp4', 0)).searchParams.get('sid'), null, 'estrazione autonoma');
  // film convertito: sottotitoli dalla stessa sessione ffmpeg
  const vod = new URL(X.transcodeUrl(proxy, 'http://h/movie/u/p/7.mkv', { v: 'copy', a: 'copy' }, { live: false, ss: 60, sid: 'v1', subs: [0, 2] }));
  assert.equal(vod.searchParams.get('subs'), '0,2');
  assert.equal(new URL(X.transcodeUrl(proxy, src, { v: 'copy', a: 'copy' }, { live: false, subs: [] })).searchParams.get('subs'), null);
  const ss = new URL(X.subtitleUrl(proxy, 'http://h/movie/u/p/7.mkv', 2, 60, 'v1'));
  assert.equal(ss.searchParams.get('sid'), 'v1');
  assert.equal(ss.searchParams.get('i'), '2');
});

test('la traccia audio scelta sopravvive a conversione e salvataggio', () => {
  assert.deepEqual(X.mergeRoute({ v: 'copy', a: 'copy', at: 2 }, { v: 'h264', a: 'copy' }), { mode: 'transcode', v: 'h264', a: 'copy', at: 2 });
  assert.deepEqual(X.mergeRoute({ v: 'copy', a: 'copy' }, { v: 'copy', a: 'aac', at: 1 }), { mode: 'transcode', v: 'copy', a: 'aac', at: 1 });
  assert.deepEqual(X.normalizeSavedRoute({ v: 'copy', a: 'copy', at: 1, t: 5 }), { mode: 'transcode', v: 'copy', a: 'copy', at: 1 }, 'solo la traccia diversa basta');
  assert.deepEqual(X.normalizeSavedRoute({ v: 'h264', a: 'aac', at: 0 }), { mode: 'transcode', v: 'h264', a: 'aac' });
  assert.equal(X.normalizeSavedRoute({ v: 'copy', a: 'copy', at: -1 }), null);
  assert.equal(X.normalizeSavedRoute({ v: 'copy', a: 'copy', at: 1.5 }), null);
});

test('lingue: codici ISO 639 e nomi', () => {
  assert.equal(X.normLang('ITA'), 'ita');
  assert.equal(X.normLang('it'), 'ita');
  assert.equal(X.normLang('it-IT'), 'ita');
  assert.equal(X.normLang('ger'), 'deu');
  assert.equal(X.normLang('fre'), 'fra');
  assert.equal(X.normLang('und'), '');
  assert.equal(X.normLang(''), '');
  assert.equal(X.normLang('x1'), '');
  assert.equal(X.normLang('kaz'), 'kaz', 'codici sconosciuti restano validi');
  assert.equal(X.langName('eng'), 'Inglese');
  assert.equal(X.langName('es'), 'Spagnolo');
  assert.equal(X.langName('kaz'), 'KAZ');
  assert.equal(X.langName(''), 'Lingua non indicata');
  assert.ok(X.PREFERRED_LANGS.every((c) => X.normLang(c) === c && X.langName(c) !== c.toUpperCase()));
});

test('etichette delle tracce', () => {
  assert.equal(X.trackLabel({ lang: 'ita', codec: 'ac3', channels: 6 }), 'Italiano · Dolby Digital 5.1');
  assert.equal(X.trackLabel({ lang: 'eng', codec: 'aac', channels: 2, title: 'Commento del regista' }), 'Inglese · AAC stereo · Commento del regista');
  assert.equal(X.trackLabel({ lang: 'ita', codec: 'subrip', title: 'Italiano', forced: true }), 'Italiano · SRT · forzati', 'titolo uguale alla lingua omesso');
  assert.equal(X.trackLabel({ lang: '', codec: 'mp2' }), 'Lingua non indicata · MP2');
  assert.equal(X.channelsLabel(1), 'mono');
  assert.equal(X.channelsLabel(8), '7.1');
  assert.equal(X.channelsLabel(3), '3 canali');
  assert.equal(X.channelsLabel(0), '');
  assert.equal(X.codecName('hdmv_pgs_subtitle'), 'PGS');
  assert.equal(X.codecName('xyz'), 'XYZ');
});

test('scelta della traccia nella lingua preferita', () => {
  const audio = [
    { index: 0, lang: 'eng', codec: 'aac' },
    { index: 1, lang: 'ita', codec: 'ac3', title: 'Commento' },
    { index: 2, lang: 'it', codec: 'eac3', default: true },
  ];
  assert.equal(X.pickTrack(audio, 'ita'), 2, 'prima la traccia predefinita');
  assert.equal(X.pickTrack(audio.slice(0, 2), 'ita'), 1);
  assert.equal(X.pickTrack(audio, 'eng'), 0);
  assert.equal(X.pickTrack(audio, 'deu'), -1);
  assert.equal(X.pickTrack(audio, ''), -1, 'nessuna preferenza');
  assert.equal(X.pickTrack(null, 'ita'), -1);
  const subs = [
    { index: 0, lang: 'ita', codec: 'hdmv_pgs_subtitle', text: false },
    { index: 1, lang: 'ita', codec: 'subrip', text: true, forced: true },
    { index: 2, lang: 'ita', codec: 'subrip', text: true },
  ];
  assert.equal(X.pickTrack(subs, 'ita', true), 2, 'testuali, non forzati');
  assert.equal(X.pickTrack(subs.slice(0, 2), 'ita', true), 1, 'forzati se sono gli unici');
  assert.equal(X.pickTrack(subs.slice(0, 1), 'ita', true), -1, 'le immagini non si mostrano');
});

test('percorso per ascoltare un\'altra traccia audio', () => {
  const direct = { mode: 'direct', v: 'copy', a: 'copy' };
  // traccia AC-3: conversione in AAC con la mappa sulla traccia scelta
  assert.deepEqual(X.audioTrackRoute(direct, { index: 1, codec: 'ac3' }), { mode: 'transcode', v: 'copy', a: 'aac', at: 1 });
  // traccia AAC: solo remux
  assert.deepEqual(X.audioTrackRoute(direct, { index: 2, codec: 'aac' }), { mode: 'transcode', v: 'copy', a: 'copy', at: 2 });
  // ritorno alla prima traccia compatibile: niente ffmpeg
  assert.deepEqual(X.audioTrackRoute(direct, { index: 0, codec: 'aac' }), direct);
  // ...a meno che il film non sia già convertito (MKV)
  assert.deepEqual(X.audioTrackRoute({ mode: 'transcode', v: 'copy', a: 'copy', at: 1 }, { index: 0, codec: 'aac' }, { forceTranscode: true }), { mode: 'transcode', v: 'copy', a: 'copy' });
  // la conversione video in corso resta
  assert.deepEqual(X.audioTrackRoute({ mode: 'transcode', v: 'h264', a: 'aac' }, { index: 1, codec: 'mp2' }), { mode: 'transcode', v: 'h264', a: 'aac', at: 1 });
  assert.deepEqual(X.audioTrackRoute({ mode: 'transcode', v: 'h264', a: 'aac', at: 1 }, { index: 0, codec: 'aac' }), { mode: 'transcode', v: 'h264', a: 'copy' });
  // MP2 dei canali DVB e Opus senza supporto: AAC
  assert.equal(X.audioTrackRoute(direct, { index: 0, codec: 'mp2' }).a, 'aac');
  assert.equal(X.audioTrackRoute(direct, { index: 1, codec: 'opus' }).a, 'aac');
  assert.equal(X.audioTrackRoute(direct, { index: 1, codec: 'opus' }, { opusOk: true }).a, 'copy');
  assert.equal(X.audioCopyOk('MP3'), true);
  assert.equal(X.audioCopyOk('aac_latm'), false);
});

test('impostazioni: valori ammessi e predefiniti', () => {
  assert.deepEqual(X.normalizeSettings(null), X.SETTINGS_DEFAULTS);
  assert.deepEqual(X.normalizeSettings({ audioOut: 'orig', quality: 'high', audioLang: 'IT', subLang: 'eng', external: 'vlc' }),
    { audioOut: 'orig', quality: 'high', audioLang: 'ita', subLang: 'eng', external: 'vlc' });
  assert.deepEqual(X.normalizeSettings({ audioOut: '7.1', quality: 'ultra', audioLang: 'und', external: 'kodi', extra: 1 }), X.SETTINGS_DEFAULTS);
});

test('dati per account: id stabile e chiavi separate', () => {
  const a = X.accountId('http://h:8080', 'mario');
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.equal(X.accountId('http://h:8080', ' mario '), a);
  assert.notEqual(X.accountId('http://h:8080', 'luigi'), a);
  assert.notEqual(X.accountId('http://altro:8080', 'mario'), a);
  // valore fisso: cambiarlo renderebbe irraggiungibili i dati già salvati
  assert.equal(X.accountId('', ''), '0f0c6cdd');
  assert.equal(X.accountKey(a, 'fav.live'), `xp.a.${a}.fav.live`);
});

test('migrazione delle chiavi senza account', () => {
  const keys = ['xp.fav.live', 'xp.recent.vod', 'xp.cat.series', 'xp.resume.123', 'xp.resume.ep.9', 'xp.route.55',
    'xp.series.last.7', 'xp.settings', 'xp.volume', 'xp.mode', 'xp.credentials', 'xp.latTarget.min', 'xp.fav.altro',
    'xp.a.0000abcd.fav.live'];
  assert.deepEqual(X.legacyKeyMoves(keys, 'deadbeef'), [
    ['xp.fav.live', 'xp.a.deadbeef.fav.live'],
    ['xp.recent.vod', 'xp.a.deadbeef.recent.vod'],
    ['xp.cat.series', 'xp.a.deadbeef.cat.series'],
    ['xp.resume.123', 'xp.a.deadbeef.resume.123'],
    ['xp.resume.ep.9', 'xp.a.deadbeef.resume.ep.9'],
    ['xp.route.55', 'xp.a.deadbeef.route.55'],
    ['xp.series.last.7', 'xp.a.deadbeef.series.last.7'],
  ]);
  assert.deepEqual(X.legacyKeyMoves(null, 'x'), []);
  // le vecchie posizioni (solo secondi) prendono la data della migrazione
  assert.deepEqual(X.migratedValue('xp.resume.123', 840, 1000), { p: 840, t: 1000 });
  assert.deepEqual(X.migratedValue('xp.route.55', { v: 'h264', t: 5 }, 1000), { v: 'h264', t: 5 });
  assert.deepEqual(X.migratedValue('xp.fav.live', [1], 1000), [1]);
});

test('posizioni di ripresa: formato vecchio e nuovo', () => {
  assert.equal(X.resumeSeconds(120), 120);
  assert.equal(X.resumeSeconds({ p: 95, t: 1 }), 95);
  assert.equal(X.resumeSeconds(null), 0);
  assert.equal(X.resumeSeconds({ t: 1 }), 0);
  assert.equal(X.resumeSeconds('12'), 0);
  assert.equal(X.resumeSeconds(-4), 0);
});

test('pulizia di posizioni e percorsi salvati', () => {
  assert.equal(X.prunableKind('xp.a.deadbeef.resume.12'), 'resume');
  assert.equal(X.prunableKind('xp.a.deadbeef.resume.ep.12'), 'resume');
  assert.equal(X.prunableKind('xp.a.deadbeef.route.12'), 'route');
  assert.equal(X.prunableKind('xp.a.deadbeef.fav.live'), '');
  assert.equal(X.prunableKind('xp.resume.12'), '');
  const now = 1000000, limits = { maxAgeMs: 100, maxCount: 2 };
  const entries = [
    { key: 'vecchia', t: now - 101 },
    { key: 'senza-data', t: 0 },
    { key: 'a', t: now - 10 },
    { key: 'b', t: now - 50 },
    { key: 'c', t: now - 1 },
  ];
  assert.deepEqual(X.staleEntries(entries, now, limits).sort(), ['b', 'senza-data', 'vecchia']);
  assert.deepEqual(X.staleEntries([], now, limits), []);
});

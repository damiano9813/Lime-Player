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

test('URL del proxy locale', () => {
  const proxy = { port: 5555, token: 'tok' };
  const src = 'http://h/live/a/b/1.ts?x=1&y=2';
  assert.equal(X.proxyUrl(null, src), src);
  const p = new URL(X.proxyUrl(proxy, src));
  assert.equal(p.host, '127.0.0.1:5555');
  assert.equal(p.pathname, '/p/tok');
  assert.equal(p.searchParams.get('u'), src);

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

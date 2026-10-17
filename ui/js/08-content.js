// Contenuti: guida TV (pannello, OSD, righe della lista), serie con stagioni ed episodi,
// catch-up dei programmi passati e scheda dei film.
'use strict';

const nowSec = () => Date.now() / 1000;
const fmtClock = (ts) => new Date(ts * 1000).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
function dayLabel(ts) {
  const d = new Date(ts * 1000), today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days === 0) return 'Oggi';
  if (days === 1) return 'Ieri';
  return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
}
const fmtMinutes = (secs) => (secs > 0 ? `${Math.round(secs / 60)} min` : '');

// ------------------------------------------------------------------ guida TV
// stream_id -> { entries, at } (anche le guide vuote, per non richiederle di continuo)
const EPG = { cache: new Map(), inflight: new Map(), timer: null, rowsTimer: null, active: 0, queue: [] };
const EPG_TTL = 10 * 60 * 1000;

function fetchShortEpg(id, force) {
  const hit = EPG.cache.get(id);
  if (!force && hit && Date.now() - hit.at < EPG_TTL) return Promise.resolve(hit.entries);
  if (EPG.inflight.has(id)) return EPG.inflight.get(id);
  const p = invoke('get_short_epg', { ...S.creds, streamId: String(id), limit: 4 })
    .then((entries) => { EPG.cache.set(id, { entries, at: Date.now() }); return entries; })
    .catch(() => { EPG.cache.set(id, { entries: [], at: Date.now() }); return []; })
    .finally(() => EPG.inflight.delete(id));
  EPG.inflight.set(id, p);
  return p;
}

function epgNowTitle(id) {
  const hit = EPG.cache.get(id);
  if (!hit || !hit.entries.length) return '';
  const { now } = XPCore.currentAndNext(hit.entries, nowSec());
  return now ? now.title : '';
}

// righe visibili: la guida si chiede solo a scroll fermo, al massimo 4 richieste insieme
function scheduleRowEpg() {
  clearTimeout(EPG.rowsTimer);
  EPG.rowsTimer = setTimeout(() => {
    if (S.mode !== 'live' || !S.creds) return;
    const first = Math.floor(scroller.scrollTop / ROW_H);
    const last = Math.min(S.filtered.length, first + Math.ceil((scroller.clientHeight || 600) / ROW_H) + 1);
    const ids = [];
    for (let i = first; i < last; i++) {
      const id = S.filtered[i] && S.filtered[i].stream_id;
      const hit = id && EPG.cache.get(id);
      if (id && !EPG.inflight.has(id) && !(hit && Date.now() - hit.at < EPG_TTL)) ids.push(id);
    }
    EPG.queue = ids;
    pumpRowEpg();
  }, 300);
}
const rerenderRows = debounce(() => { if (S.mode === 'live') renderList(true); }, 120);
function pumpRowEpg() {
  while (EPG.active < 4 && EPG.queue.length) {
    const id = EPG.queue.shift();
    EPG.active += 1;
    fetchShortEpg(id).then((entries) => { if (entries.length) rerenderRows(); }).finally(() => { EPG.active -= 1; pumpRowEpg(); });
  }
}

function renderEpgPanel(item) {
  const hit = EPG.cache.get(item.stream_id);
  const { now, next } = XPCore.currentAndNext(hit ? hit.entries : [], nowSec());
  $('info-epg').classList.toggle('hidden', !now && !next);
  $('epg-now-title').textContent = now ? now.title : 'Nessuna informazione sul programma in onda';
  $('epg-now-time').textContent = now ? `${fmtClock(now.start_ts)} – ${fmtClock(now.end_ts)}` : '';
  $('epg-now-bar').style.width = (now ? XPCore.epgProgress(now, nowSec()) * 100 : 0) + '%';
  $('epg-now-desc').textContent = now ? now.description : '';
  $('epg-next-title').textContent = next ? next.title : '—';
  $('epg-next-time').textContent = next ? fmtClock(next.start_ts) : '';
  // OSD in alto: categoria e programma in onda
  if (now && S.current === item) {
    const cat = S.catNames.live.get(item.category_id) || 'Live TV';
    $('osd-sub').textContent = `${cat}  ·  ${now.title}`;
  }
  return now;
}

async function loadEpgPanel(item) {
  const entries = await fetchShortEpg(item.stream_id);
  if (S.current !== item) return;
  renderEpgPanel(item);
  clearInterval(EPG.timer);
  if (!entries.length) return;
  EPG.timer = setInterval(async () => {
    if (S.current !== item) { clearInterval(EPG.timer); return; }
    // programma finito e guida senza il successivo: si riscarica
    if (!renderEpgPanel(item)) { await fetchShortEpg(item.stream_id, true); if (S.current === item) renderEpgPanel(item); }
  }, 30000);
}

// ------------------------------------------------------------------ pannello info
function clearContentInfo() {
  clearInterval(EPG.timer);
  ['info-epg', 'info-meta', 'info-plot', 'info-cast', 'catchup-box'].forEach((id) => $(id).classList.add('hidden'));
  $('info-meta').textContent = ''; $('info-plot').textContent = ''; $('info-cast').textContent = '';
}

function showMeta(parts, plot, cast) {
  const meta = parts.filter(Boolean).join('  ·  ');
  $('info-meta').textContent = meta;
  $('info-meta').classList.toggle('hidden', !meta);
  $('info-plot').textContent = plot || '';
  $('info-plot').classList.toggle('hidden', !plot);
  $('info-cast').textContent = cast ? 'Con: ' + cast : '';
  $('info-cast').classList.toggle('hidden', !cast);
}

function showPoster(url, item) {
  if (!url || S.current !== item) return;
  const logo = $('info-logo');
  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  img.className = 'w-full h-full object-cover';
  img.onload = () => { if (S.current === item) { logo.textContent = ''; logo.appendChild(img); } };
  img.src = url;
}

function renderContentInfo(item, mode) {
  clearContentInfo();
  if (mode === 'live') {
    loadEpgPanel(item);
    if (String(item.tv_archive) === '1') loadCatchup(item);
    return;
  }
  if (item._catchup) {
    showMeta([fmtMinutes(item._duration)], item._plot, '');
    if (item._channel) loadCatchup(item._channel);
    return;
  }
  if (item._kind === 'episode') {
    const e = item._episode || {};
    showMeta([XPCore.episodeLabel(e), fmtMinutes(e.duration_secs), e.release_date], e.plot || item._plot, '');
    return;
  }
  vodInfoFor(item).then((info) => {
    if (!info || S.current !== item) return;
    const m = info.meta;
    showMeta([m.genre, (m.release_date || '').slice(0, 4), fmtMinutes(m.duration_secs), m.director ? 'Regia: ' + m.director : '',
      m.rating > 0 ? '★ ' + Number(m.rating).toFixed(1) : ''], m.plot, m.cast);
    showPoster(m.image, item);
    // durata nota prima di ffprobe: serve alla barra di avanzamento dei film convertiti
    if (P.vodTranscoded && !isFinite(P.vodDuration) && m.duration_secs > 0) { P.vodDuration = m.duration_secs; updateTimeUi(); }
  });
}

// ------------------------------------------------------------------ scheda film
const VODINFO = new Map();
function vodInfoFor(item) {
  if (!item || !S.creds) return Promise.resolve(null);
  const id = String(item.stream_id);
  if (!VODINFO.has(id)) {
    VODINFO.set(id, invoke('get_vod_info', { ...S.creds, vodId: id }).catch(() => { VODINFO.delete(id); return null; }));
  }
  return VODINFO.get(id);
}

// ------------------------------------------------------------------ catch-up
async function loadCatchup(channel) {
  const box = $('catchup-box'), list = $('catchup-list');
  box.classList.remove('hidden');
  $('catchup-sub').textContent = '';
  list.innerHTML = '<p class="text-xs text-ink-subtle px-2 py-3">Caricamento della guida…</p>';
  let entries;
  try { entries = await invoke('get_epg_day', { ...S.creds, streamId: String(channel.stream_id) }); } catch { entries = null; }
  const playing = S.current && (S.current === channel || S.current._channel === channel);
  if (!playing) return;
  if (!entries) { box.classList.add('hidden'); return; }
  const days = Number(channel.tv_archive_duration) || 3;
  const progs = XPCore.archivedPrograms(entries, nowSec(), days);
  $('catchup-sub').textContent = progs.length ? `${progs.length} programmi · archivio di ${days} giorni` : '';
  if (!progs.length) {
    list.innerHTML = '<p class="text-xs text-ink-subtle px-2 py-3">Nessun programma passato nella guida di questo canale.</p>';
    return;
  }
  const curStart = S.current && S.current._catchup ? S.current._entry.start_ts : null;
  let html = '', lastDay = '';
  progs.forEach((p, i) => {
    const day = dayLabel(p.start_ts);
    if (day !== lastDay) { html += `<p class="overline px-2 pt-2 pb-1">${escapeHtml(day)}</p>`; lastDay = day; }
    const on = p.start_ts === curStart;
    html += `<button data-cu="${i}" class="w-full flex items-center gap-3 px-2 py-1.5 rounded-lg text-left transition-colors ${on ? 'bg-accent-soft text-accent-ink' : 'hover:bg-s3'}">
      <span class="text-[11px] font-semibold tabular-nums text-ink-subtle w-24 shrink-0">${fmtClock(p.start_ts)} – ${fmtClock(p.end_ts)}</span>
      <span class="text-sm truncate ${on ? 'font-bold' : 'font-medium text-ink'}">${escapeHtml(p.title || 'Senza titolo')}</span>
    </button>`;
  });
  list.innerHTML = html;
  list.onclick = (ev) => {
    const b = ev.target.closest('[data-cu]');
    if (b) playCatchup(channel, progs[+b.dataset.cu]);
  };
}

function playCatchup(channel, e) {
  const item = {
    stream_id: `cu-${channel.stream_id}-${e.start_ts}`,
    name: e.title || 'Programma',
    stream_icon: channel.stream_icon,
    category_id: channel.category_id,
    container_extension: 'ts',
    _catchup: true,
    _channel: channel,
    _entry: e,
    _url: XPCore.timeshiftUrl(S.creds, channel.stream_id, e.start, (e.end_ts - e.start_ts) / 60),
    _duration: e.end_ts - e.start_ts,
    _plot: e.description,
    _sub: `${channel.name}  ·  ${dayLabel(e.start_ts)} ${fmtClock(e.start_ts)}`,
  };
  playItem(item, 'vod');
}

// ------------------------------------------------------------------ serie
function seasonEpisodes(info, season) { return info.episodes.filter((e) => e.season === season); }
// i titoli spesso ripetono nome della serie e codice: si mostra la parte dopo "SxxEyy"
function episodeTitle(e) {
  const t = String(e.title || '');
  const m = /S\d{1,2}E\d{1,3}\s*[-–:]\s*(.+)$/i.exec(t);
  return (m ? m[1] : t).trim() || `Episodio ${e.episode_num}`;
}

async function openSeries(it) {
  S.seriesView = { item: it, info: null, season: null };
  $('series-view').classList.remove('hidden');
  $('series-title').textContent = it.name;
  $('series-meta').textContent = [it.genre, (it.release_date || '').slice(0, 4), it.rating > 0 ? '★ ' + Number(it.rating).toFixed(1) : ''].filter(Boolean).join('  ·  ');
  $('series-plot').textContent = it.plot || '';
  const cover = $('series-cover');
  cover.textContent = initials(it.name);
  if (it.stream_icon && /^https?:\/\//i.test(it.stream_icon)) {
    cover.innerHTML = `<img src="${escapeHtml(it.stream_icon)}" referrerpolicy="no-referrer" class="w-full h-full object-cover" alt="">`;
  }
  $('series-seasons').innerHTML = '';
  $('series-episodes').innerHTML = '<p class="text-sm text-ink-muted p-4">Caricamento episodi…</p>';
  let info;
  try { info = await invoke('get_series_info', { ...S.creds, seriesId: String(it.stream_id) }); } catch (e) {
    if (S.seriesView && S.seriesView.item === it) $('series-episodes').innerHTML = `<p class="text-sm text-danger p-4">${escapeHtml(errText(e))}</p>`;
    return;
  }
  if (!S.seriesView || S.seriesView.item !== it) return;
  S.seriesView.info = info;
  if (info.meta.plot && !it.plot) $('series-plot').textContent = info.meta.plot;
  if (!info.episodes.length) { $('series-episodes').innerHTML = '<p class="text-sm text-ink-muted p-4">Nessun episodio disponibile.</p>'; return; }
  // si riparte dalla stagione dell'ultimo episodio visto
  const lastId = lsGet('xp.series.last.' + it.stream_id, null);
  const last = info.episodes.find((e) => String(e.id) === String(lastId));
  S.seriesView.season = last ? last.season : info.seasons[0].season_number;
  renderSeasons();
  renderEpisodes(last ? last.id : null);
}

function closeSeries() {
  S.seriesView = null;
  $('series-view').classList.add('hidden');
}

function renderSeasons() {
  const v = S.seriesView;
  $('series-seasons').innerHTML = v.info.seasons.map((s) => {
    const on = s.season_number === v.season;
    return `<button data-season="${s.season_number}" role="tab" aria-selected="${on}" class="btn btn-sm shrink-0 ${on ? 'bg-accent-soft text-accent-ink border-accent' : 'btn-secondary'}">Stagione ${s.season_number}<span class="opacity-70 font-semibold">${s.episode_count}</span></button>`;
  }).join('');
}

function renderEpisodes(scrollToId) {
  const v = S.seriesView;
  if (!v || !v.info) return;
  const eps = seasonEpisodes(v.info, v.season);
  const curId = S.current && S.current._kind === 'episode' ? String(S.current.stream_id) : null;
  $('series-episodes').innerHTML = eps.map((e) => {
    const on = String(e.id) === curId;
    const resume = lsGet('xp.resume.ep.' + e.id, 0);
    const pct = e.duration_secs > 0 && resume > 30 ? Math.min(100, (resume / e.duration_secs) * 100) : 0;
    return `<button data-ep="${escapeHtml(e.id)}" class="relative w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${on ? 'row-active' : 'hover:bg-s2'}">
      <span class="w-14 shrink-0 text-[11px] font-bold tabular-nums ${on ? 'text-accent-ink' : 'text-ink-subtle'}">${XPCore.episodeLabel(e)}</span>
      <span class="flex-1 min-w-0">
        <span class="block text-sm truncate ${on ? 'text-accent-ink font-bold' : 'text-ink font-medium'}">${escapeHtml(episodeTitle(e))}</span>
        <span class="block text-[11px] font-medium text-ink-subtle">${escapeHtml([fmtMinutes(e.duration_secs), resume > 30 ? 'riprendi da ' + fmtTime(resume) : ''].filter(Boolean).join(' · '))}</span>
        ${pct ? `<span class="block h-0.5 mt-1 rounded-full bg-s4 overflow-hidden"><span class="block h-full bg-accent" style="width:${pct}%"></span></span>` : ''}
      </span>
    </button>`;
  }).join('');
  if (scrollToId) {
    const el = $('series-episodes').querySelector(`[data-ep="${CSS.escape(String(scrollToId))}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
  }
}

function playEpisode(e, seriesItem, info) {
  const label = XPCore.episodeLabel(e);
  lsSet('xp.series.last.' + seriesItem.stream_id, e.id);
  const item = {
    stream_id: String(e.id),
    name: `${seriesItem.name}  ·  ${label}`,
    stream_icon: e.image || seriesItem.stream_icon,
    category_id: seriesItem.category_id,
    container_extension: e.container_extension || 'mkv',
    _kind: 'episode',
    _series: slimItem(seriesItem),
    _episode: e,
    _episodes: info.episodes,
    _seriesInfo: info,
    _codecs: e.codecs,
    _duration: e.duration_secs,
    _plot: info.meta.plot,
    _sub: `${seriesItem.name}  ·  ${label}  ·  ${episodeTitle(e)}`,
  };
  playItem(item, 'vod');
  if (S.seriesView && S.seriesView.item.stream_id === seriesItem.stream_id) {
    if (S.seriesView.season !== e.season) { S.seriesView.season = e.season; renderSeasons(); }
    renderEpisodes(e.id);
  }
}

function stepEpisode(delta) {
  const cur = S.current;
  if (!cur || cur._kind !== 'episode') return;
  const eps = cur._episodes || [];
  const i = eps.findIndex((e) => String(e.id) === String(cur.stream_id));
  const target = eps[i + delta];
  if (target) playEpisode(target, cur._series, cur._seriesInfo);
}

// fine di un episodio: si passa al successivo dopo un breve avviso
function onPlaybackEnded(item) {
  if (item._kind !== 'episode') return;
  const next = XPCore.nextEpisode(item._episodes, item.stream_id);
  if (!next) { toast('Ultimo episodio disponibile della serie', 'ok'); return; }
  toast(`Tra poco: ${XPCore.episodeLabel(next)} · ${episodeTitle(next)}`);
  setTimeout(() => { if (S.current === item) playEpisode(next, item._series, item._seriesInfo); }, 3000);
}

$('series-back').addEventListener('click', closeSeries);
$('series-seasons').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-season]');
  if (!b || !S.seriesView) return;
  S.seriesView.season = +b.dataset.season;
  renderSeasons();
  renderEpisodes();
});
$('series-episodes').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-ep]');
  const v = S.seriesView;
  if (!b || !v || !v.info) return;
  const e = v.info.episodes.find((x) => String(x.id) === b.dataset.ep);
  if (e) playEpisode(e, v.item, v.info);
});

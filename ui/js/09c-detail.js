// Scheda di un film o di una serie: sfondo, trama e cast, "Riproduci" o "Riprendi", La mia lista;
// per le serie stagioni ed episodi. Film ed episodi partono a tutta finestra sopra la scheda, che
// resta aperta e si aggiorna quando si torna indietro (onPlayerClosed).
'use strict';

const SIMILAR_MAX = 10;
// `loaded`: la scheda è arrivata (info null se la richiesta non è riuscita)
const D = { mode: '', item: null, info: null, loaded: false, season: null, seq: 0, returnFocus: null, similar: [] };
const detailView = $('detail-view'), detailCard = $('detail-card');
const detailOpen = () => !detailView.classList.contains('hidden');
let seriesBusy = false;

function openDetail(mode, item) {
  if (!item || !S.creds) return;
  if (!detailOpen()) D.returnFocus = document.activeElement;
  closeAcctMenu();
  const seq = ++D.seq;
  Object.assign(D, { mode, item, info: null, loaded: false, season: null });
  detailView.classList.remove('hidden');
  renderDetail();
  detailView.scrollTop = 0;
  detailView.focus({ preventScroll: true });
  // telecomando: subito su "Riproduci"
  const tvFocus = () => { if (PLATFORM.tv && [document.body, detailView].includes(document.activeElement)) focusFirst(detailView); };
  tvFocus();
  (mode === 'vod' ? vodInfoFor : seriesInfoFor)(item).then((info) => {
    if (seq !== D.seq || !detailOpen()) return;
    D.info = info;
    D.loaded = true;
    renderDetail();
    tvFocus();
  });
}

function closeDetail() {
  if (!detailOpen()) return;
  D.seq += 1;
  detailView.classList.add('hidden');
  detailCard.innerHTML = '';
  D.item = null; D.info = null; D.similar = [];
  const f = D.returnFocus;
  D.returnFocus = null;
  if (f && f.focus && document.contains(f) && !playerFull()) f.focus({ preventScroll: true });
}

// dopo il player: "Riprendi" e avanzamento degli episodi cambiano
function refreshDetail() {
  if (!detailOpen()) return;
  const top = detailView.scrollTop;
  renderDetail();
  detailView.scrollTop = top;
}

// ------------------------------------------------------------------ cosa riprodurre
// episodio da cui ripartire: quello interrotto, il successivo di quello finito o il primo
function seriesTarget(item, info) {
  if (!info || !info.episodes.length) return null;
  const c = XPCore.continueSeries([item], (it) => lsGet(ak('series.last.' + it.stream_id), null),
    (id) => lsGet(ak('resume.ep.' + id), null), 1)[0];
  const ep = c && info.episodes.find((x) => String(x.id) === c.ep.id);
  if (ep) return { ep, resume: !c.next && c.p > 30, next: c.next };
  return { ep: info.episodes[0], resume: false, next: false };
}

// avvia una serie dall'episodio giusto; `host` mostra l'attesa degli episodi
async function playSeries(item, host) {
  if (seriesBusy) return;
  seriesBusy = true;
  const acct = S.acct;
  const spin = document.createElement('span');
  spin.className = 'absolute inset-0 z-10 grid place-items-center bg-black/55 rounded-[inherit] text-ink';
  spin.innerHTML = SPIN_SVG;
  if (host) { host.classList.add('relative'); host.appendChild(spin); }
  let info;
  try { info = await seriesInfoFor(item); } finally { seriesBusy = false; spin.remove(); }
  // nel frattempo si è cambiata playlist
  if (S.acct !== acct) return;
  const t = seriesTarget(item, info);
  if (!info) toast('Episodi non disponibili: riprova tra poco', 'error');
  else if (!t) toast('Nessun episodio disponibile per questa serie', 'error');
  else playEpisode(t.ep, item, info);
}

function resumeOfFilm(item) {
  const r = XPCore.resumeProgress(lsGet(resumeKey(item), null));
  // dopo i primi 30 s e prima dei titoli di coda, come "Continua a guardare"
  return r.p > 30 && !(r.d > 0 && r.pct >= 0.95) ? r : null;
}

// ------------------------------------------------------------------ disegno
const FAV_ADD = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const FAV_ON = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';

function actionsHtml() {
  const it = D.item, series = D.mode === 'series';
  let play;
  if (series) {
    const t = seriesTarget(it, D.info);
    const label = !D.loaded ? 'Riproduci' : !t ? 'Nessun episodio' : `${t.resume ? 'Riprendi' : 'Riproduci'} ${XPCore.episodeLabel(t.ep)}`;
    play = `<button class="btn btn-play btn-lg" data-dt-play${t ? '' : ' disabled'}>${PLAY_SVG.replace('w-5 h-5 ml-0.5', 'w-6 h-6')}${escapeHtml(label)}</button>`;
  } else {
    const r = resumeOfFilm(it);
    play = `<button class="btn btn-play btn-lg" data-dt-play>${PLAY_SVG.replace('w-5 h-5 ml-0.5', 'w-6 h-6')}${r ? 'Riprendi' : 'Riproduci'}</button>` +
      (r ? '<button class="btn btn-glass btn-lg" data-dt-restart>Ricomincia</button>' : '');
  }
  const fav = isFav(D.mode, it.stream_id);
  const favLabel = fav ? 'Togli dalla mia lista' : 'Aggiungi alla mia lista';
  return play + `<button class="round-btn" data-dt-fav aria-pressed="${fav}" title="${favLabel}" aria-label="${favLabel}">${fav ? FAV_ON : FAV_ADD}</button>`;
}
function updateDetailActions() {
  const el = detailOpen() && detailCard.querySelector('[data-dt-actions]');
  if (el) el.innerHTML = actionsHtml();
}

function renderDetail() {
  const it = D.item, m = (D.info && D.info.meta) || {}, series = D.mode === 'series';
  const backdrop = okUrl(m.backdrop) ? m.backdrop : '';
  const poster = okUrl(m.image) ? m.image : okUrl(it.stream_icon) ? it.stream_icon : '';
  const img = (cls, src) => `<img class="${cls}" src="${escapeHtml(src)}" referrerpolicy="no-referrer" alt="">`;
  const media = backdrop ? img('hero-bg', backdrop) : poster ? img('hero-bg blur', poster) : '';
  const seasons = series && D.info ? new Set(D.info.episodes.map((e) => e.season)).size : 0;
  const meta = [(m.release_date || it.release_date || '').slice(0, 4),
    series ? (seasons ? `${seasons} stagion${seasons === 1 ? 'e' : 'i'}` : '') : fmtMinutes(m.duration_secs),
    ratingLabel(m.rating || it.rating)].filter(Boolean);
  const resume = series ? null : resumeOfFilm(it);
  const resumeHtml = resume ? `<div class="flex items-center gap-3 mt-4 max-w-md">
      <span class="flex-1 h-1 rounded-full bg-s4 overflow-hidden"><span class="block h-full bg-accent" style="width:${(resume.pct * 100).toFixed(1)}%"></span></span>
      <span class="text-xs font-semibold text-ink-muted whitespace-nowrap">${escapeHtml(minutesLeft(resume.p, resume.d) || 'Riprendi da ' + fmtTime(resume.p))}</span></div>` : '';
  const plot = m.plot || it.plot || '';
  const plotHtml = plot ? `<p class="mt-4 text-[15px] leading-relaxed text-ink select-text">${escapeHtml(plot)}</p>`
    : !D.loaded ? '<div class="mt-4 space-y-2"><div class="skel h-3.5 rounded w-full"></div><div class="skel h-3.5 rounded w-11/12"></div><div class="skel h-3.5 rounded w-2/3"></div></div>'
    : '<p class="mt-4 text-sm text-ink-subtle">Nessuna trama disponibile.</p>';
  const cat = S.catNames[D.mode].get(it.category_id) || '';
  const facts = [['Cast', m.cast], ['Regia', m.director], ['Genere', m.genre || it.genre], ['Categoria', cat]]
    .filter(([, v]) => v).map(([k, v]) => `<p class="line-clamp-3"><span class="text-ink-subtle">${k}: </span><span class="text-ink select-text">${escapeHtml(v)}</span></p>`).join('');
  detailCard.innerHTML = `
    <div class="dt-hero">
      ${media}
      <div class="dt-shade"></div>
      <button class="dt-close" data-dt-close title="Chiudi (Esc)" aria-label="Chiudi">${X_SVG.replace('w-3.5 h-3.5', 'w-5 h-5')}</button>
      <div class="absolute inset-x-0 bottom-0 px-10 pb-8 flex items-end gap-6">
        ${poster && !backdrop ? `<img class="w-32 aspect-[2/3] object-cover rounded-md shadow-pop shrink-0" src="${escapeHtml(poster)}" referrerpolicy="no-referrer" alt="">` : ''}
        <div class="min-w-0 flex-1">
          <p class="flex items-center gap-2 mb-2 text-[12px] font-extrabold tracking-[.18em] uppercase text-ink-muted"><span class="w-1 h-3.5 rounded-sm bg-accent"></span>${MODE_LABEL[D.mode]}</p>
          <h2 id="detail-title" class="text-[clamp(1.8rem,3.2vw,2.75rem)] leading-[1.08] font-extrabold tracking-tight line-clamp-2 [text-shadow:0_2px_12px_rgba(0,0,0,.5)]">${escapeHtml(it.name)}</h2>
          <div class="flex flex-wrap items-center gap-3 mt-5" data-dt-actions>${actionsHtml()}</div>
        </div>
      </div>
    </div>
    <div class="dt-body px-10 pt-3 pb-8 grid gap-x-10 gap-y-5 grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div class="min-w-0">
        ${meta.length ? `<p class="text-sm font-semibold text-ink-muted">${meta.map(escapeHtml).join('<span class="mx-2 text-ink-subtle">·</span>')}</p>` : ''}
        ${resumeHtml}
        ${plotHtml}
      </div>
      <div class="min-w-0 text-sm space-y-2.5">${facts}</div>
    </div>
    ${series ? `<section id="dt-episodes" class="px-10 pb-8">${episodesHtml()}</section>` : ''}
    ${similarHtml()}`;
}

function episodesHtml() {
  const head = (extra) => `<div class="flex items-center gap-4 mb-3"><h3 class="text-xl font-extrabold flex-1">Episodi</h3>${extra || ''}</div>`;
  if (!D.loaded) return head() + '<div class="space-y-3">' + '<div class="skel h-24 rounded-md"></div>'.repeat(3) + '</div>';
  const info = D.info;
  if (!info) return head() + '<div class="flex items-center gap-3 text-sm text-danger bg-danger-soft rounded-lg px-4 py-3"><span class="flex-1">Episodi non disponibili.</span><button class="btn btn-secondary btn-sm" data-dt-retry>Riprova</button></div>';
  if (!info.episodes.length) return head() + '<p class="text-sm text-ink-muted">Nessun episodio disponibile.</p>';
  const target = seriesTarget(D.item, info);
  const counts = new Map();
  info.episodes.forEach((e) => counts.set(e.season, (counts.get(e.season) || 0) + 1));
  if (!counts.has(D.season)) D.season = target ? target.ep.season : info.episodes[0].season;
  const select = counts.size > 1
    ? `<select class="genre-select !rounded-md !border-line-strong" data-season aria-label="Stagione">${Array.from(counts).map(([n, c]) =>
      `<option value="${n}"${n === D.season ? ' selected' : ''}>Stagione ${n} (${c} episodi)</option>`).join('')}</select>`
    : `<span class="text-sm font-semibold text-ink-muted">Stagione ${D.season}</span>`;
  const fallback = okUrl(info.meta.backdrop) ? info.meta.backdrop : '';
  const rows = seasonEpisodes(info, D.season).map((e) => {
    const thumb = okUrl(e.image) ? e.image : fallback;
    const p = getResume(ak('resume.ep.' + e.id));
    const pct = e.duration_secs > 0 && p > 30 ? Math.min(1, p / e.duration_secs) : 0;
    const on = target && String(target.ep.id) === String(e.id);
    return `<button class="ep-row${on ? ' on' : ''}" data-ep="${escapeHtml(e.id)}" title="${escapeHtml(XPCore.episodeLabel(e) + ' · ' + episodeTitle(e))}">
      <span class="w-8 shrink-0 text-center text-xl font-bold text-ink-subtle tabular-nums">${escapeHtml(e.episode_num)}</span>
      <span class="ep-thumb">${thumb ? `<img src="${escapeHtml(thumb)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="">` : ''}
        <span class="pcard-fb text-[11px]${thumb ? ' hidden' : ''}">${escapeHtml(XPCore.episodeLabel(e))}</span>
        <span class="pcard-play"><span class="!w-9 !h-9">${PLAY_SVG.replace('w-5 h-5', 'w-4 h-4')}</span></span>${progressBar(pct)}</span>
      <span class="flex-1 min-w-0">
        <span class="flex items-baseline gap-3"><span class="flex-1 min-w-0 truncate text-[15px] font-bold text-ink">${escapeHtml(episodeTitle(e))}</span>
          <span class="text-sm font-semibold text-ink-muted shrink-0">${escapeHtml(fmtMinutes(e.duration_secs))}</span></span>
        ${e.plot ? `<span class="block mt-1 text-[13px] leading-snug text-ink-muted line-clamp-2">${escapeHtml(e.plot)}</span>` : ''}
      </span>
    </button>`;
  }).join('');
  return head(select) + `<div>${rows}</div>`;
}

// altri titoli della stessa categoria, se il catalogo è già in memoria
function similarHtml() {
  const items = catalogItems(D.mode), it = D.item;
  const g = items && groupsFor(D.mode, items).find((x) => x.id === it.category_id);
  D.similar = g ? g.items.filter((x) => x.stream_id !== it.stream_id).slice(0, SIMILAR_MAX) : [];
  if (!D.similar.length) return '';
  const cards = D.similar.map((x, i) => `<div class="pcard" role="listitem"><button class="pcard-btn" data-dt-similar="${i}" title="${escapeHtml(x.name)}">
      <span class="pcard-img">${posterImg(x)}</span><span class="pcard-title">${escapeHtml(x.name)}</span></button></div>`).join('');
  return `<section class="pb-10"><h3 class="text-xl font-extrabold px-10 mb-4">Altri titoli simili</h3>
    <div class="dt-similar grid grid-cols-5 gap-x-3 gap-y-5 px-10" role="list">${cards}</div></section>`;
}

// ------------------------------------------------------------------ eventi
detailView.addEventListener('click', (ev) => { if (ev.target === detailView) closeDetail(); });
detailCard.addEventListener('click', (ev) => {
  const t = ev.target, it = D.item;
  if (!it) return;
  if (t.closest('[data-dt-close]')) { closeDetail(); return; }
  if (t.closest('[data-dt-fav]')) { toggleFav(D.mode, it); return; }
  const play = t.closest('[data-dt-play]');
  if (play) {
    if (D.mode === 'vod') playItem(it, 'vod');
    else { const tg = seriesTarget(it, D.info); if (tg) playEpisode(tg.ep, it, D.info); }
    return;
  }
  if (t.closest('[data-dt-restart]')) { playItem(it, 'vod', { ss: 0 }); return; }
  const ep = t.closest('[data-ep]');
  if (ep && D.info) {
    const e = D.info.episodes.find((x) => String(x.id) === ep.dataset.ep);
    if (e) playEpisode(e, it, D.info);
    return;
  }
  const sim = t.closest('[data-dt-similar]');
  if (sim) { const x = D.similar[+sim.dataset.dtSimilar]; if (x) openDetail(D.mode, x); detailView.scrollTop = 0; return; }
  if (t.closest('[data-dt-retry]')) openDetail(D.mode, it);
});
detailCard.addEventListener('change', (ev) => {
  const sel = ev.target.closest('[data-season]');
  if (!sel || !D.info) return;
  D.season = Number(sel.value);
  $('dt-episodes').innerHTML = episodesHtml();
  $('dt-episodes').querySelector('[data-season]').focus();
});
detailCard.addEventListener('error', onImgError, true);

// ritorno dal player a tutta finestra: si aggiornano scheda e righe, il focus torna dov'era
function onPlayerClosed() {
  refreshDetail();
  if (browseVisible()) renderBrowse(false);
  (detailOpen() ? detailView : browseVisible() ? browseScroller : document.body).focus({ preventScroll: true });
}

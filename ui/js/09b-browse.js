// Viste in stile streaming: barra in alto con le sezioni, Home, Film e Serie con hero e righe di
// locandine, griglia di una categoria e ricerca su film, serie e canali. La Live TV resta la lista
// dei canali con player e guida (04-library.js, 05-list.js); film ed episodi si guardano a tutta
// finestra (07-controls.js) e si aprono dalla scheda (09c-detail.js).
'use strict';

const VIEWS = ['home', 'live', 'vod', 'series'];
// locandine per riga, per pagina della griglia e per tipo nei risultati della ricerca
const ROW_MAX = 40, GRID_PAGE = 120, SEARCH_MAX = 60;
// righe disegnate subito; le altre quando si avvicinano scorrendo
const ROWS_EAGER = 4;
// griglia "aggiunti di recente": oltre questo numero non serve
const NEW_MAX = 300;
const NEW = '__new__';
const MODE_LABEL = { vod: 'Film', series: 'Serie TV', live: 'Canali' };
const B = {
  // griglia aperta { mode, cat, top } (cat: id categoria, FAV o NEW; top: scroll delle righe)
  grid: null,
  // testo della ricerca nella barra in alto (vuoto: nessuna ricerca)
  search: '',
  // righe della pagina disegnata e hero mostrato
  rows: [], heroCur: null,
  seq: 0, epgSeq: 0, epgTimer: null, io: null, hoverWrap: null,
  // hero scelto per sezione: resta lo stesso finché non si cambia playlist
  hero: {},
  // cataloghi in caricamento (e pagine che li aspettano) ed errori, per sezione
  pending: new Map(), waiting: new Set(), errors: {},
  // righe per categoria già calcolate: catalogo -> { cats, groups }
  groups: new WeakMap(),
};
const browseScroller = $('browse-scroller'), browsePage = $('browse-page'), gsearch = $('gsearch-input');
const browseVisible = () => !$('browse-view').classList.contains('hidden');
const okUrl = (u) => !!u && /^https?:\/\//i.test(u);
const addedField = (mode) => (mode === 'series' ? 'last_modified' : 'added');
const newLabel = (mode) => (mode === 'series' ? 'Serie aggiornate di recente' : 'Film aggiunti di recente');
const minutesLeft = (p, d) => (d > p ? `${Math.max(1, Math.round((d - p) / 60))} min rimasti` : '');
const ratingLabel = (r) => (r > 0 ? '★ ' + Number(r).toFixed(1) : '');

const PLAY_SVG = '<svg class="w-5 h-5 ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11.04-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14z"/></svg>';
const INFO_SVG = '<svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v6M12 7.5h.01"/></svg>';
const X_SVG = '<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const CHEV = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
const SPIN_SVG = '<svg class="w-8 h-8 spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"/></svg>';

// ------------------------------------------------------------------ cataloghi
const catalogKey = (mode) => mode + '|' + ALL;
const catalogItems = (mode) => (S.categories[mode] && S.cache.get(catalogKey(mode))) || null;

// Catalogo completo di una sezione (categorie e tutti gli elementi), condiviso con la lista della
// Live TV. Con "prefer" arriva subito quello salvato su disco; il backend lo riscarica in
// background e lo manda con l'evento list-updated (onCatalogUpdated).
function ensureCatalog(mode, force) {
  if (!force && catalogItems(mode)) return Promise.resolve(catalogItems(mode));
  if (B.pending.has(mode)) return B.pending.get(mode);
  const acct = S.acct;
  const p = (async () => {
    if ((force || !S.categories[mode]) && !await fetchCategories(mode, force)) return null;
    const args = { ...S.creds, categoryId: '', cache: force ? 'refresh' : 'prefer' };
    const res = mode === 'series' ? await invoke('get_series_list', args) : await invoke('get_streams', { ...args, mode: MODE_API[mode].streams });
    if (S.acct !== acct) return null;
    // le sottoliste ricavate in memoria dal catalogo vecchio vanno ricalcolate
    if (force) for (const k of Array.from(S.cache.keys())) if (k.startsWith(mode + '|')) S.cache.delete(k);
    S.cache.set(catalogKey(mode), prepareItems(res.items));
    S.listAge.set(catalogKey(mode), res.fetched_at);
    delete B.errors[mode];
    return S.cache.get(catalogKey(mode));
  })().catch((e) => {
    if (S.acct === acct) B.errors[mode] = errText(e);
    return null;
  }).finally(() => { if (B.pending.get(mode) === p) B.pending.delete(mode); });
  B.pending.set(mode, p);
  return p;
}

// catalogo già in memoria, oppure null: lo si carica e la pagina si ridisegna quando arriva
function needCatalog(mode) {
  const items = catalogItems(mode);
  if (items || B.errors[mode]) return items;
  // una sola attesa per sezione, anche se la pagina si ridisegna più volte nel frattempo
  if (!B.waiting.has(mode)) {
    B.waiting.add(mode);
    ensureCatalog(mode).then(() => {
      B.waiting.delete(mode);
      if (S.creds && browseVisible()) renderBrowse(false);
    });
  }
  return null;
}

// lista riscaricata in background: la pagina si aggiorna restando dov'era
const onCatalogUpdated = debounce(() => { if (S.creds && browseVisible()) renderBrowse(false); }, 400);

// righe per categoria, ricalcolate solo se cambiano catalogo o categorie
function groupsFor(mode, items) {
  const cats = S.categories[mode] || [];
  const hit = B.groups.get(items);
  if (hit && hit.cats === cats) return hit.groups;
  const groups = XPCore.groupByCategory(items, cats);
  B.groups.set(items, { cats, groups });
  return groups;
}

// ------------------------------------------------------------------ viste
function updateNav() {
  document.querySelectorAll('#nav [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === S.view && !B.search)));
}

// "In riproduzione" nella barra: un canale o un catch-up che continua mentre si guarda altro
function updateNowPill() {
  const el = $('now-pill');
  const show = !!S.current && !playerFull() && (S.view !== 'live' || !!B.search);
  el.classList.toggle('hidden', !show);
  if (!show) return;
  const name = S.current._sub || S.current.name;
  el.innerHTML = `${ICONS.eq.replace('class="eq"', `class="eq${isPaused() ? ' paused' : ''}"`)}<span class="truncate">${escapeHtml(name)}</span>`;
  el.title = 'Torna alla Live TV: ' + name;
}

function setView(view) {
  if (!VIEWS.includes(view) || !S.creds) return;
  closeCatPick(false);
  closeDetail();
  closeAcctMenu();
  S.view = view;
  B.grid = null;
  clearGlobalSearch(false);
  applyView(true, true);
}

// mostra la Live TV o la pagina a righe, secondo la sezione e la ricerca
function applyView(reset, focus) {
  const browse = S.view !== 'live' || !!B.search;
  $('app-view').classList.toggle('view-browse', browse);
  $('live-view').classList.toggle('hidden', browse);
  $('browse-view').classList.toggle('hidden', !browse);
  updateNav();
  updateNowPill();
  if (browse) {
    closeGuide();
    renderBrowse(reset);
    if (focus) browseScroller.focus({ preventScroll: true });
    return;
  }
  clearBrowse();
  $('topbar').classList.remove('solid');
  // la lista dei canali si carica alla prima apertura della Live TV
  if (!S.liveReady) { S.liveReady = true; switchMode('live', true); return; }
  // era nascosta: va ridisegnata con le misure vere
  renderList(true);
  locateCurrent(false);
}

function clearBrowse() {
  B.seq += 1;
  B.epgSeq += 1;
  clearInterval(B.epgTimer);
  if (B.io) { B.io.disconnect(); B.io = null; }
  browsePage.innerHTML = '';
  B.rows = []; B.heroCur = null; B.hoverWrap = null;
}

// cambio di playlist: hero, errori, griglia e ricerca ripartono da zero
function resetBrowse() {
  B.hero = {}; B.errors = {}; B.pending.clear(); B.waiting.clear(); B.grid = null;
  closeCatPick(false);
  clearGlobalSearch(false);
  closeAcctMenu();
  closeDetail();
  clearBrowse();
  SERIESINFO.clear();
}

// ------------------------------------------------------------------ dati delle righe
// film e serie da riprendere, dal più recente: { mode, item, p, d, pct, t } (+ ep, next per le serie)
function continueEntries() {
  const savedAt = (k) => { const v = lsGet(k, null); return (v && Number(v.t)) || 0; };
  const films = XPCore.continueFilms(S.recent.vod, (it) => lsGet(resumeKey(it), null), ROW_MAX)
    .map((e) => ({ ...e, mode: 'vod', t: savedAt(resumeKey(e.item)) }));
  const series = XPCore.continueSeries(S.recent.series, (it) => lsGet(ak('series.last.' + it.stream_id), null),
    (id) => lsGet(ak('resume.ep.' + id), null), ROW_MAX)
    .map((e) => ({ ...e, mode: 'series', t: Math.max(savedAt(ak('series.last.' + e.item.stream_id)), savedAt(ak('resume.ep.' + e.ep.id))) }));
  return films.concat(series).sort((a, b) => b.t - a.t).slice(0, ROW_MAX);
}
const posters = (mode, items) => items.map((item) => ({ mode, item }));

// riga dei nuovi arrivi di una sezione: in caricamento, con errore, assente se il catalogo è vuoto
function newRow(mode, items) {
  if (!items) return B.errors[mode] ? { title: newLabel(mode), error: mode } : { title: newLabel(mode), loading: true };
  const fresh = XPCore.recentlyAdded(items, addedField(mode), ROW_MAX);
  return fresh.length ? { title: newLabel(mode), kind: 'poster', entries: posters(mode, fresh), all: { mode, cat: NEW } } : null;
}

// in evidenza: tra i 30 arrivati più di recente con locandina, a caso, uno che abbia lo sfondo
function featured(mode, items) {
  if (B.hero[mode]) return B.hero[mode];
  const withArt = (list) => list.filter((it) => okUrl(it.stream_icon));
  let pool = withArt(XPCore.recentlyAdded(items, addedField(mode), 30));
  if (!pool.length) pool = withArt(items.slice(0, 200)).slice(0, 30);
  if (!pool.length) return null;
  const picks = pool.map((it) => [Math.random(), it]).sort((a, b) => a[0] - b[0]).slice(0, 3).map((x) => x[1]);
  const acct = S.acct;
  B.hero[mode] = { loading: true, mode };
  Promise.all(picks.map(mode === 'vod' ? vodInfoFor : seriesInfoFor)).then((infos) => {
    if (S.acct !== acct) return;
    const k = Math.max(0, infos.findIndex((x) => x && x.meta.backdrop));
    B.hero[mode] = { mode, item: picks[k] };
    if (browseVisible() && B.heroCur && B.heroCur.loading && B.heroCur.mode === mode) renderBrowse(false);
  });
  return B.hero[mode];
}

// ------------------------------------------------------------------ pagine
function homePage() {
  const cont = continueEntries();
  const vod = needCatalog('vod'), series = needCatalog('series');
  const rows = [];
  if (cont.length) rows.push({ title: 'Continua a guardare', kind: 'continue', entries: cont });
  const mine = posters('vod', S.favorites.vod).concat(posters('series', S.favorites.series));
  if (mine.length) rows.push({ title: 'La mia lista', kind: 'poster', entries: mine });
  if (S.recent.live.length) rows.push({ title: 'Ultimi canali visti', kind: 'channel', remove: 'recent', entries: posters('live', S.recent.live.slice(0, ROW_MAX)) });
  if (S.favorites.live.length) rows.push({ title: 'Canali preferiti', kind: 'channel', remove: 'fav', entries: posters('live', S.favorites.live) });
  rows.push(newRow('vod', vod), newRow('series', series));
  let hero = cont.length ? { mode: cont[0].mode, item: cont[0].item, entry: cont[0] } : null;
  if (!hero && vod && vod.length) hero = featured('vod', vod);
  if (!hero && series && series.length) hero = featured('series', series);
  // in attesa del catalogo: lo spazio dell'hero resta, senza saltare quando arriva
  if (!hero && ((!vod && !B.errors.vod) || (!series && !B.errors.series))) hero = { loading: true };
  const list = rows.filter(Boolean);
  const empty = !list.length && !hero;
  return { hero, rows: list, body: empty ? emptyHtml('Niente da mostrare: apri un canale, un film o una serie per ritrovarli qui.') : null };
}

// pulsante che apre la scelta delle categorie (ricerca e più categorie insieme)
const catPickBtn = (mode, label) => ((S.categories[mode] || []).length
  ? `<button type="button" class="genre-select text-left" data-catpick="${mode}" aria-haspopup="dialog" title="Cerca e scegli una o più categorie">${escapeHtml(label)}</button>` : '');

function pageHead(mode, cls) {
  return `<div class="${cls}"><h1 class="text-[28px] leading-tight font-extrabold tracking-tight">${MODE_LABEL[mode]}</h1>${catPickBtn(mode, 'Categorie')}</div>`;
}

function modePage(mode) {
  const head = pageHead(mode, 'page-head');
  const items = needCatalog(mode);
  if (!items) {
    if (B.errors[mode]) return { head, rows: [{ title: newLabel(mode), error: mode }] };
    return { head, hero: { loading: true }, rows: [{ title: newLabel(mode), loading: true }, { title: 'Categorie', loading: true }] };
  }
  if (!items.length) return { head, body: emptyHtml(`Nessun contenuto in ${MODE_LABEL[mode]} per questa playlist.`) };
  const rows = [];
  const cont = continueEntries().filter((e) => e.mode === mode);
  if (cont.length) rows.push({ title: 'Continua a guardare', kind: 'continue', entries: cont });
  if (S.favorites[mode].length) rows.push({ title: 'La mia lista', kind: 'poster', entries: posters(mode, S.favorites[mode]), all: { mode, cat: FAV } });
  const fresh = newRow(mode, items);
  if (fresh) rows.push(fresh);
  for (const g of groupsFor(mode, items)) {
    rows.push({ title: g.name, kind: 'poster', entries: posters(mode, g.items.slice(0, ROW_MAX)), all: { mode, cat: g.id }, lazy: rows.length >= ROWS_EAGER });
  }
  return { head, hero: featured(mode, items), rows };
}

const catName = (mode, id) => S.catNames[mode].get(id) || 'Categoria';
function gridTitle(mode, grid) {
  if (grid.cats) return grid.cats.length === 1 ? catName(mode, grid.cats[0]) : `${grid.cats.length} categorie`;
  return grid.cat === FAV ? 'La mia lista' : newLabel(mode);
}
// titoli delle categorie scelte, nell'ordine del provider
function gridItems(mode, grid, items) {
  if (grid.cats) {
    const want = new Set(grid.cats.map(String));
    return groupsFor(mode, items).filter((g) => want.has(String(g.id))).flatMap((g) => g.items);
  }
  if (grid.cat === FAV) return S.favorites[mode];
  return XPCore.recentlyAdded(items, addedField(mode), NEW_MAX);
}
// categorie scelte, ognuna con la × per toglierla (con una sola basta il titolo)
function gridChips(mode, cats) {
  if (cats.length < 2) return '';
  return `<div class="flex flex-wrap gap-2 px-[var(--gutter)] mb-4">${cats.map((id) =>
    `<span class="cat-chip"><span class="truncate">${escapeHtml(catName(mode, id))}</span><button type="button" data-cat-remove="${escapeHtml(id)}" title="Togli questa categoria" aria-label="Togli ${escapeHtml(catName(mode, id))}">${X_SVG.replace('w-3.5 h-3.5', 'w-3 h-3')}</button></span>`).join('')}</div>`;
}
function gridPage() {
  const grid = B.grid, mode = grid.mode;
  const items = needCatalog(mode);
  const list = items ? gridItems(mode, grid, items) : null;
  const count = list ? `<span class="text-sm font-semibold text-ink-subtle tabular-nums">${list.length.toLocaleString('it-IT')} titoli</span>` : '';
  const head = `<div class="flex items-center gap-4 px-[var(--gutter)] mb-4">
    <button class="round-btn !w-10 !h-10" data-grid-back title="Indietro (Esc)" aria-label="Indietro">${CHEV('M15 18l-6-6 6-6').replace('<svg', '<svg class="w-5 h-5"')}</button>
    <div class="min-w-0"><p class="overline">${MODE_LABEL[mode]}</p><h1 class="text-[28px] leading-tight font-extrabold tracking-tight truncate">${escapeHtml(gridTitle(mode, grid))}</h1></div>
    ${count}${grid.cats ? `<span class="flex-1"></span>${catPickBtn(mode, 'Modifica categorie')}` : ''}
  </div>` + (grid.cats ? gridChips(mode, grid.cats) : '');
  if (!list) return { body: head + (B.errors[mode] ? errorHtml(mode) : skelGrid()) };
  if (!list.length) {
    return { body: head + emptyHtml(grid.cat === FAV ? 'La tua lista è vuota: aggiungi film e serie dalla loro scheda.'
      : grid.cats && grid.cats.length > 1 ? 'Nessun titolo in queste categorie.' : 'Nessun titolo in questa categoria.') };
  }
  return { head, rows: [{ kind: 'poster', grid: true, entries: posters(mode, list) }] };
}

function searchPage() {
  const q = B.search;
  const rows = [];
  let loading = false;
  for (const mode of ['vod', 'series', 'live']) {
    const items = needCatalog(mode);
    if (!items) { loading = loading || !B.errors[mode]; continue; }
    const r = XPCore.searchItems(items, q, SEARCH_MAX);
    if (r.total) rows.push({ title: MODE_LABEL[mode], count: r.total, kind: mode === 'live' ? 'channel' : 'poster', grid: true, entries: posters(mode, r.items) });
  }
  const status = loading ? `<span class="flex items-center gap-2 text-sm text-ink-muted"><svg class="w-4 h-4 spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"/></svg>Caricamento dei cataloghi…</span>` : '';
  const head = `<div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-[var(--gutter)] mb-2">
    <h1 class="text-2xl font-extrabold tracking-tight">Risultati per “${escapeHtml(q)}”</h1>${status}</div>`;
  if (!rows.length && !loading) return { body: head + emptyHtml(`Nessun film, serie o canale corrisponde a “${q}”. Prova con meno parole.`) };
  return { head, rows };
}

// ------------------------------------------------------------------ disegno
function renderBrowse(reset) {
  const top = reset ? 0 : browseScroller.scrollTop;
  clearBrowse();
  const page = B.search ? searchPage() : B.grid ? gridPage() : S.view === 'home' ? homePage() : modePage(S.view);
  B.rows = page.rows || [];
  B.heroCur = page.hero || null;
  const body = page.body != null ? page.body : B.rows.map(browseRowHtml).join('');
  browsePage.innerHTML = (page.hero ? heroHtml(page.hero) : '') +
    `<div class="rows${page.hero ? '' : ' plain'}">${page.hero ? '' : page.head || ''}${body}</div>` + (page.hero ? page.head || '' : '');
  if (page.hero && !page.hero.loading) fillHero(page.hero, B.seq);
  observeLazy();
  browseScroller.scrollTop = top;
  updateTopbar();
  loadCardEpg();
}

const emptyHtml = (msg) => `<p class="mx-[var(--gutter)] max-w-xl text-sm text-ink-muted bg-s2 border border-dashed border-line rounded-xl px-5 py-6">${escapeHtml(msg)}</p>`;
const errorHtml = (mode) => `<div class="mx-[var(--gutter)] flex flex-wrap items-center gap-3 text-sm text-danger bg-danger-soft rounded-xl px-4 py-3">
  <span class="flex-1 min-w-0">Catalogo ${MODE_LABEL[mode].toLowerCase()} non disponibile: ${escapeHtml(B.errors[mode] || '')}</span>
  <button class="btn btn-secondary btn-sm" data-retry="${mode}">Riprova</button></div>`;
const skelCards = (n) => '<div class="pcard"><span class="pcard-img skel"></span></div>'.repeat(n);
const skelGrid = () => `<div class="pgrid">${skelCards(14)}</div>`;

function browseRowHtml(row, r) {
  const head = row.title ? `<div class="row-head${row.grid ? ' mb-1' : ''}"><h2 class="row-title">${escapeHtml(row.title)}</h2>` +
    (row.count ? `<span class="text-xs font-semibold text-ink-subtle tabular-nums">${row.count > row.entries.length ? `primi ${row.entries.length} di ${row.count.toLocaleString('it-IT')}` : row.count}</span>` : '') +
    (row.all ? `<button class="row-all" data-all="${r}">Vedi tutti ›</button>` : '') + '</div>' : '';
  if (row.error) return `<section class="space-y-3">${head}${errorHtml(row.error)}</section>`;
  if (row.loading) return `<section>${head}<div class="row-track" aria-hidden="true">${skelCards(9)}</div></section>`;
  const wide = row.kind === 'channel' ? ' wide' : '';
  if (row.grid) {
    row.shown = Math.min(row.entries.length, GRID_PAGE);
    const more = row.shown < row.entries.length ? `<div class="h-px" data-more="${r}"></div>` : '';
    return `<section class="${row.title ? 'pt-2' : ''}">${head}<div class="pgrid${wide} pt-3" role="list" data-r="${r}">${cardsHtml(row, r, 0, row.shown)}</div>${more}</section>`;
  }
  const lazy = row.lazy ? ' loading' : '';
  return `<section aria-label="${escapeHtml(row.title)}">${head}
    <div class="row-wrap" data-start>
      <button class="row-arrow l" data-scroll="-1" tabindex="-1" aria-hidden="true">${CHEV('M15 18l-6-6 6-6')}</button>
      <div class="row-track${wide}${lazy}" role="list" data-r="${r}">${row.lazy ? '' : cardsHtml(row, r, 0, row.entries.length)}</div>
      <button class="row-arrow r" data-scroll="1" tabindex="-1" aria-hidden="true">${CHEV('M9 18l6-6-6-6')}</button>
    </div></section>`;
}

function cardsHtml(row, r, from, to) {
  let html = '';
  for (let i = from; i < to; i++) {
    const e = row.entries[i];
    html += row.kind === 'channel' ? channelCard(row, e, r, i) : row.kind === 'continue' ? continueCard(e, r, i) : posterCard(e, r, i);
  }
  return html;
}

function posterImg(item, cls) {
  const ok = okUrl(item.stream_icon);
  return (ok ? `<img src="${escapeHtml(item.stream_icon)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt=""${cls ? ` class="${cls}"` : ''}>` : '') +
    `<span class="pcard-fb${ok ? ' hidden' : ''}">${escapeHtml(item.name)}</span>`;
}
const progressBar = (pct) => (pct > 0 ? `<span class="pcard-bar"><span style="width:${Math.max(3, pct * 100).toFixed(1)}%"></span></span>` : '');
const actBtn = (attr, side, label, svg) => `<button class="pcard-act ${side}" ${attr} title="${label}" aria-label="${label}">${svg}</button>`;

function posterCard(e, r, i) {
  const it = e.item;
  const sub = [(it.release_date || '').slice(0, 4), ratingLabel(it.rating)].filter(Boolean).join(' · ');
  return `<div class="pcard" role="listitem">
    <button class="pcard-btn" data-r="${r}" data-i="${i}" title="${escapeHtml(it.name)}">
      <span class="pcard-img">${posterImg(it)}</span>
      <span class="pcard-title">${escapeHtml(it.name)}</span>${sub ? `<span class="pcard-sub">${escapeHtml(sub)}</span>` : ''}
    </button></div>`;
}

function continueLine(e) {
  if (e.mode === 'vod') return minutesLeft(e.p, e.d) || `Riprendi da ${fmtTime(e.p)}`;
  const label = e.ep.label || 'Ultimo episodio visto';
  if (e.next) return `Prossimo: ${label}`;
  return e.p > 30 ? [label, minutesLeft(e.p, e.d) || `da ${fmtTime(e.p)}`].join(' · ') : label;
}
function continueCard(e, r, i) {
  const it = e.item;
  return `<div class="pcard" role="listitem">
    <button class="pcard-btn" data-r="${r}" data-i="${i}" title="${escapeHtml((e.mode === 'vod' ? 'Riprendi: ' : 'Continua: ') + it.name)}">
      <span class="pcard-img">${posterImg(it)}<span class="pcard-play"><span>${PLAY_SVG}</span></span>${progressBar(e.pct)}</span>
      <span class="pcard-title">${escapeHtml(it.name)}</span><span class="pcard-sub">${escapeHtml(continueLine(e))}</span>
    </button>
    ${actBtn(`data-info="${r}:${i}"`, 'left-1.5', 'Altre info', INFO_SVG.replace('w-5 h-5', 'w-4 h-4'))}
    ${actBtn(`data-remove="${r}:${i}"`, 'right-1.5', 'Togli da Continua a guardare', X_SVG)}
  </div>`;
}

function channelCard(row, e, r, i) {
  const it = e.item, id = escapeHtml(it.stream_id);
  const playing = S.current && S.currentMode === 'live' && !S.current._catchup && S.current.stream_id === it.stream_id;
  const cat = S.catNames.live.get(it.category_id) || '';
  const label = row.remove === 'fav' ? 'Togli dai canali preferiti' : 'Togli dagli ultimi visti';
  return `<div class="pcard${playing ? ' playing' : ''}" role="listitem">
    <button class="pcard-btn" data-r="${r}" data-i="${i}" title="${escapeHtml(it.name)}">
      <span class="pcard-img wide">${posterImg(it, 'logo')}<span class="pcard-play"><span>${PLAY_SVG}</span></span>
        ${playing ? `<span class="absolute top-2 left-2 glass rounded px-1.5 py-1">${ICONS.eq.replace('class="eq"', `class="eq${isPaused() ? ' paused' : ''}"`)}</span>` : ''}
        <span class="pcard-bar hidden"><span data-epg-bar="${id}" style="width:0%"></span></span></span>
      <span class="pcard-title">${it.num ? `<span class="text-ink-subtle tabular-nums">${escapeHtml(it.num)}</span> · ` : ''}${escapeHtml(it.name)}</span>
      <span class="pcard-sub" data-epg="${id}" data-cat="${escapeHtml(cat)}">${escapeHtml(epgNowTitle(it.stream_id) || cat)}</span>
    </button>
    ${row.remove ? actBtn(`data-remove="${r}:${i}"`, 'right-1.5', label, X_SVG) : ''}
  </div>`;
}

// righe lontane e pagine successive delle griglie: si disegnano quando ci si avvicina
function observeLazy() {
  const targets = browsePage.querySelectorAll('.row-track.loading, [data-more]');
  if (!targets.length) return;
  B.io = new IntersectionObserver((list) => {
    for (const en of list) {
      if (!en.isIntersecting) continue;
      const t = en.target;
      const row = B.rows[+(t.dataset.r || t.dataset.more)];
      if (!row) continue;
      if (t.dataset.more != null) {
        const grid = t.previousElementSibling, to = Math.min(row.entries.length, row.shown + GRID_PAGE);
        grid.insertAdjacentHTML('beforeend', cardsHtml(row, +t.dataset.more, row.shown, to));
        row.shown = to;
        if (to >= row.entries.length) { B.io.unobserve(t); t.remove(); }
        continue;
      }
      B.io.unobserve(t);
      t.innerHTML = cardsHtml(row, +t.dataset.r, 0, row.entries.length);
      t.classList.remove('loading');
    }
  }, { root: browseScroller, rootMargin: '700px 0px' });
  targets.forEach((t) => B.io.observe(t));
}

// ------------------------------------------------------------------ hero
function heroMeta(h, info) {
  const m = info ? info.meta : {};
  const it = h.item;
  return [(m.release_date || it.release_date || '').slice(0, 4), fmtMinutes(m.duration_secs), ratingLabel(m.rating || it.rating), m.genre || it.genre]
    .filter(Boolean).join('  ·  ');
}
function heroPlayLabel(h) {
  const e = h.entry;
  if (!e) return 'Riproduci';
  if (e.mode === 'vod') return 'Riprendi';
  return `${e.next ? 'Riproduci' : 'Riprendi'} ${e.ep.label || ''}`.trim();
}
function heroHtml(h) {
  if (h.loading) return '<div class="hero skel" aria-hidden="true"></div>';
  const e = h.entry;
  const tag = e ? 'Continua a guardare' : MODE_LABEL[h.mode];
  const progress = e && e.pct > 0
    ? `<div class="flex items-center gap-3 mt-5 max-w-sm"><span class="flex-1 h-1 rounded-full bg-white/30 overflow-hidden"><span class="block h-full bg-accent" style="width:${(e.pct * 100).toFixed(1)}%"></span></span><span class="text-xs font-semibold text-ink-muted whitespace-nowrap">${escapeHtml(continueLine(e))}</span></div>`
    : e ? `<p class="mt-4 text-sm font-semibold text-ink">${escapeHtml(continueLine(e))}</p>` : '';
  return `<div class="hero">
    <div class="absolute inset-0" data-hero-media></div>
    <div class="hero-shade"></div>
    <div class="hero-content">
      <p class="flex items-center gap-2 mb-3 text-[13px] font-extrabold tracking-[.18em] uppercase text-ink-muted"><span class="w-1 h-4 rounded-sm bg-accent"></span>${escapeHtml(tag)}</p>
      <h1 class="hero-title">${escapeHtml(h.item.name)}</h1>
      <p class="mt-4 text-sm font-semibold text-ink-muted" data-hero-meta>${escapeHtml(heroMeta(h, null))}</p>
      <p class="hero-plot mt-3" data-hero-plot>${escapeHtml(h.item.plot || '')}</p>
      ${progress}
      <div class="flex items-center gap-3 mt-7">
        <button class="btn btn-play btn-lg" data-hero-play>${PLAY_SVG.replace('w-5 h-5 ml-0.5', 'w-6 h-6')}${escapeHtml(heroPlayLabel(h))}</button>
        <button class="btn btn-glass btn-lg" data-hero-info>${INFO_SVG.replace('w-5 h-5', 'w-6 h-6')}Altre info</button>
      </div>
    </div>
  </div>`;
}

// sfondo (o locandina sfocata), trama e dati dalla scheda del film o della serie
async function fillHero(h, seq) {
  const info = await (h.mode === 'vod' ? vodInfoFor : seriesInfoFor)(h.item);
  if (seq !== B.seq) return;
  const media = browsePage.querySelector('[data-hero-media]');
  if (!media) return;
  const m = info ? info.meta : {};
  const poster = okUrl(m.image) ? m.image : okUrl(h.item.stream_icon) ? h.item.stream_icon : '';
  if (okUrl(m.backdrop)) media.innerHTML = `<img class="hero-bg" src="${escapeHtml(m.backdrop)}" referrerpolicy="no-referrer" alt="">`;
  else if (poster) {
    media.innerHTML = `<img class="hero-bg blur" src="${escapeHtml(poster)}" referrerpolicy="no-referrer" alt="">` +
      `<img class="hero-poster" src="${escapeHtml(poster)}" referrerpolicy="no-referrer" alt="">`;
  }
  if (!info) return;
  browsePage.querySelector('[data-hero-meta]').textContent = heroMeta(h, info);
  if (m.plot) browsePage.querySelector('[data-hero-plot]').textContent = m.plot;
}

// ------------------------------------------------------------------ guida dei canali nelle schede
function loadCardEpg() {
  const ids = new Set();
  B.rows.forEach((row) => { if (row.kind === 'channel') row.entries.forEach((e) => ids.add(e.item.stream_id)); });
  if (!ids.size) return;
  const seq = B.epgSeq, queue = Array.from(ids);
  let active = 0;
  ids.forEach(updateCardEpg);
  const pump = () => {
    while (active < 3 && queue.length && seq === B.epgSeq) {
      const id = queue.shift();
      active += 1;
      fetchShortEpg(id).then(() => { if (seq === B.epgSeq) updateCardEpg(id); }).finally(() => { active -= 1; pump(); });
    }
  };
  pump();
  B.epgTimer = setInterval(() => ids.forEach(updateCardEpg), 60000);
}
function updateCardEpg(id) {
  const hit = EPG.cache.get(id);
  // guida non ancora arrivata: resta la categoria
  if (!hit) return;
  const sel = CSS.escape(String(id));
  const { now } = XPCore.currentAndNext(hit.entries, nowSec());
  browsePage.querySelectorAll(`[data-epg="${sel}"]`).forEach((el) => {
    el.textContent = now ? `${fmtClock(now.start_ts)} · ${now.title}` : (el.dataset.cat || 'Nessun programma in guida');
  });
  browsePage.querySelectorAll(`[data-epg-bar="${sel}"]`).forEach((bar) => {
    bar.style.width = (now ? XPCore.epgProgress(now, nowSec()) * 100 : 0) + '%';
    bar.parentElement.classList.toggle('hidden', !now);
  });
}

// ------------------------------------------------------------------ azioni
const entryAt = (ref) => { const [r, i] = String(ref).split(':').map(Number); const row = B.rows[r]; return row ? { row, e: row.entries[i] } : {}; };

// riprende un film o una serie da "Continua a guardare" (o dall'hero)
function playEntry(e, btn) {
  if (e.mode === 'vod') playItem(e.item, 'vod');
  else playSeries(e.item, btn);
}

function activateCard(btn) {
  const row = B.rows[+btn.dataset.r];
  const e = row && row.entries[+btn.dataset.i];
  if (!e) return;
  if (row.kind === 'channel') { playItem(e.item, 'live'); return; }
  if (row.kind === 'continue') { playEntry(e, btn.querySelector('.pcard-img')); return; }
  openDetail(e.mode, e.item);
}

function removeEntry(row, e) {
  if (row.kind === 'continue') {
    lsDel(e.mode === 'vod' ? resumeKey(e.item) : ak('series.last.' + e.item.stream_id));
  } else if (row.remove === 'fav') {
    toggleFav('live', e.item);
    return;
  } else if (row.remove === 'recent') {
    const id = e.item.stream_id;
    S.recent.live = S.recent.live.filter((x) => x.stream_id !== id);
    lsSet(ak('recent.live'), S.recent.live);
    if (S.mode === 'live') {
      renderCategories();
      if (S.selectedCat.live === RECENT) { S.list = prepareItems(S.recent.live.slice()); applyFilter(false); }
    }
  }
  renderBrowse(false);
}

// g: { mode, cats } (categorie) oppure { mode, cat } (una categoria, FAV o NEW)
function openGrid(g) {
  if (!g) return;
  const cats = g.cats || (g.cat !== FAV && g.cat !== NEW ? [g.cat] : null);
  B.grid = { mode: g.mode, cat: cats ? null : g.cat, cats, top: B.grid ? B.grid.top : browseScroller.scrollTop };
  renderBrowse(true);
}
function removeGridCat(id) {
  const cats = B.grid.cats.filter((c) => String(c) !== String(id));
  if (!cats.length) { closeGrid(); return; }
  B.grid.cats = cats;
  renderBrowse(false);
}
function closeGrid() {
  if (!B.grid) return;
  const top = B.grid.top;
  B.grid = null;
  renderBrowse(true);
  browseScroller.scrollTop = top;
}

function scrollRow(btn) {
  const t = btn.parentElement.querySelector('.row-track');
  const pad = parseFloat(getComputedStyle(t).paddingLeft) || 0;
  t.scrollBy({ left: Number(btn.dataset.scroll) * (t.clientWidth - 2 * pad), behavior: 'smooth' });
}
function updateArrows(w) {
  const t = w.querySelector('.row-track');
  if (!t) return;
  w.toggleAttribute('data-start', t.scrollLeft <= 2);
  w.toggleAttribute('data-end', t.scrollLeft + t.clientWidth >= t.scrollWidth - 2);
}
function updateTopbar() { $('topbar').classList.toggle('solid', browseScroller.scrollTop > 40); }

// dopo la scheda o il player: preferiti, "Continua a guardare" e la lista cambiano
function onFavChanged() {
  if (browseVisible()) renderBrowse(false);
  updateDetailActions();
}

// --- ricerca nella barra in alto: film, serie e canali insieme ---
const runGlobalSearch = debounce(() => {
  const q = gsearch.value.trim();
  if (q === B.search || !S.creds) return;
  B.search = q;
  if (q) { closeDetail(); closeCatPick(false); }
  applyView(true, false);
}, 200);
function clearGlobalSearch(apply) {
  gsearch.value = '';
  $('gsearch-clear').classList.add('hidden');
  if (!B.search) return;
  B.search = '';
  if (apply) applyView(true, false);
}

// --- scelta delle categorie di Film e Serie: ricerca e più categorie insieme ---
const catpick = $('catpick'), catpickSearch = $('catpick-search'), catpickList = $('catpick-list');
const CP = { mode: '', sel: [], anchor: null };
const CP_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';
const catpickOpen = () => !catpick.classList.contains('hidden');

function openCatPick(mode, anchor) {
  CP.mode = mode;
  CP.anchor = anchor;
  // si parte dalle categorie già scelte: quelle della griglia o, nella Live TV, quelle della lista
  if (mode === 'live') {
    const sel = S.selectedCat.live;
    CP.sel = sel === MULTI ? S.multiCats.live.slice() : !isVirtualCat(sel) ? [String(sel)] : [];
  } else CP.sel = B.grid && B.grid.mode === mode && B.grid.cats ? B.grid.cats.map(String) : [];
  catpickSearch.value = '';
  catpick.classList.remove('hidden');
  anchor.setAttribute('aria-expanded', 'true');
  renderCatPick();
  placeCatPick();
  catpickSearch.focus();
}
function closeCatPick(focusBack) {
  if (!catpickOpen()) return;
  catpick.classList.add('hidden');
  const a = CP.anchor;
  CP.anchor = null;
  if (a && document.contains(a)) {
    a.setAttribute('aria-expanded', 'false');
    if (focusBack) a.focus({ preventScroll: true });
  }
}
function toggleCatPick(mode, anchor) {
  if (catpickOpen() && CP.anchor === anchor) closeCatPick(false);
  else openCatPick(mode, anchor);
}
// sotto il pulsante, dentro la finestra; se il pulsante non c'è più (pagina ridisegnata) si chiude
function placeCatPick() {
  if (!catpickOpen()) return;
  const a = CP.anchor && document.contains(CP.anchor) ? CP.anchor : document.querySelector(`[data-catpick="${CP.mode}"]`);
  if (!a) { closeCatPick(false); return; }
  CP.anchor = a;
  const r = a.getBoundingClientRect(), w = catpick.offsetWidth;
  catpick.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  catpick.style.top = Math.min(r.bottom + 6, innerHeight - catpick.offsetHeight - 8) + 'px';
}

// categorie con almeno un titolo (tutte, finché il catalogo non è arrivato) e quanti ne hanno
function catPickEntries(mode) {
  const items = catalogItems(mode);
  if (!items) return (S.categories[mode] || []).map((c) => ({ id: String(c.category_id), name: c.category_name, count: null }));
  return groupsFor(mode, items).map((g) => ({ id: String(g.id), name: g.name, count: g.items.length }));
}
function renderCatPick() {
  const terms = normKey(catpickSearch.value).split(/\s+/).filter(Boolean);
  const all = catPickEntries(CP.mode);
  const list = terms.length ? all.filter((c) => { const k = normKey(c.name); return terms.every((t) => k.includes(t)); }) : all;
  const sel = new Set(CP.sel);
  catpickList.innerHTML = list.length ? list.map((c) => `<button type="button" class="menu-opt${sel.has(c.id) ? ' on' : ''}" role="option" aria-selected="${sel.has(c.id)}" data-pick="${escapeHtml(c.id)}" title="${escapeHtml(c.name)}">
      <span class="cp-box">${CP_CHECK}</span><span class="truncate min-w-0 flex-1">${XPCore.highlight(c.name, terms)}</span>${c.count != null ? `<small class="tabular-nums">${c.count.toLocaleString('it-IT')}</small>` : ''}</button>`).join('')
    : `<p class="text-xs text-ink-subtle p-3">Nessuna categoria corrisponde a “${escapeHtml(catpickSearch.value.trim())}”.</p>`;
  updateCatPickFooter();
}
function updateCatPickFooter() {
  const n = CP.sel.length;
  $('catpick-show').disabled = !n;
  $('catpick-show').textContent = n > 1 ? `Mostra ${n} categorie` : 'Mostra';
  $('catpick-clear').disabled = !n;
  $('catpick-count').textContent = n ? `${n} scelt${n === 1 ? 'a' : 'e'}` : 'Spunta una o più categorie';
}
function togglePick(btn) {
  const id = btn.dataset.pick;
  const on = !CP.sel.includes(id);
  CP.sel = on ? CP.sel.concat(id) : CP.sel.filter((x) => x !== id);
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-selected', String(on));
  updateCatPickFooter();
}
// nell'ordine del provider, non in quello dei clic
function applyCatPick() {
  if (!CP.sel.length) return;
  const order = catPickEntries(CP.mode).map((c) => c.id);
  const cats = CP.sel.slice().sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const mode = CP.mode;
  closeCatPick(false);
  if (mode === 'live') {
    selectCategories(cats);
    const a = $('cat-list').querySelector('[aria-current="true"]');
    if (a) a.focus({ preventScroll: true });
    return;
  }
  openGrid({ mode, cats });
  browseScroller.focus({ preventScroll: true });
}

catpickSearch.addEventListener('input', debounce(renderCatPick, 60));
catpickList.addEventListener('click', (ev) => { const b = ev.target.closest('[data-pick]'); if (b) togglePick(b); });
$('catpick-show').addEventListener('click', applyCatPick);
$('catpick-clear').addEventListener('click', () => { CP.sel = []; renderCatPick(); catpickSearch.focus(); });
// Esc chiude; Invio mostra le categorie spuntate (senza spunte, la prima trovata); le frecce scorrono l'elenco
catpick.addEventListener('keydown', (ev) => {
  const opts = Array.from(catpickList.querySelectorAll('[data-pick]'));
  const i = opts.indexOf(document.activeElement);
  if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeCatPick(true); return; }
  if (ev.key === 'Enter' && ev.target === catpickSearch) {
    ev.preventDefault(); ev.stopPropagation();
    if (!CP.sel.length && opts.length) CP.sel = [opts[0].dataset.pick];
    applyCatPick();
    return;
  }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault(); ev.stopPropagation();
    const next = ev.key === 'ArrowDown' ? (i < 0 ? 0 : i + 1) : i - 1;
    if (next < 0) catpickSearch.focus();
    else if (opts[next]) opts[next].focus();
    return;
  }
  // gli altri tasti restano al popup (niente scorciatoie della pagina sotto)
  ev.stopPropagation();
});
document.addEventListener('mousedown', (ev) => {
  if (catpickOpen() && !catpick.contains(ev.target) && !ev.target.closest('[data-catpick]')) closeCatPick(false);
});
browseScroller.addEventListener('scroll', placeCatPick, { passive: true });
$('cat-list').addEventListener('scroll', placeCatPick, { passive: true });
window.addEventListener('resize', placeCatPick);

// --- menu dell'account ---
const acctMenuOpen = () => !$('acct-menu').classList.contains('hidden');
function closeAcctMenu() {
  $('acct-menu').classList.add('hidden');
  $('acct-btn').setAttribute('aria-expanded', 'false');
}

// ------------------------------------------------------------------ eventi
document.querySelectorAll('#nav [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('now-pill').addEventListener('click', () => setView('live'));
gsearch.addEventListener('input', () => {
  $('gsearch-clear').classList.toggle('hidden', !gsearch.value);
  runGlobalSearch();
});
$('gsearch-clear').addEventListener('click', () => { clearGlobalSearch(true); gsearch.focus(); });
$('acct-btn').addEventListener('click', (ev) => {
  ev.stopPropagation();
  const open = !acctMenuOpen();
  $('acct-menu').classList.toggle('hidden', !open);
  $('acct-btn').setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (ev) => { if (acctMenuOpen() && !$('acct-menu').contains(ev.target)) closeAcctMenu(); });

browseScroller.addEventListener('scroll', updateTopbar, { passive: true });
browsePage.addEventListener('click', (ev) => {
  const t = ev.target;
  const scrollBtn = t.closest('[data-scroll]');
  if (scrollBtn) { scrollRow(scrollBtn); return; }
  const pick = t.closest('[data-catpick]');
  if (pick) { toggleCatPick(pick.dataset.catpick, pick); return; }
  const rmCat = t.closest('[data-cat-remove]');
  if (rmCat && B.grid && B.grid.cats) { removeGridCat(rmCat.dataset.catRemove); return; }
  const rm = t.closest('[data-remove]');
  if (rm) { const { row, e } = entryAt(rm.dataset.remove); if (e) removeEntry(row, e); return; }
  const info = t.closest('[data-info]');
  if (info) { const { e } = entryAt(info.dataset.info); if (e) openDetail(e.mode, e.item); return; }
  const card = t.closest('[data-i]');
  if (card) { activateCard(card); return; }
  const all = t.closest('[data-all]');
  if (all) { const row = B.rows[+all.dataset.all]; if (row) openGrid(row.all); return; }
  const h = B.heroCur;
  if (h && !h.loading && t.closest('[data-hero-play]')) { if (h.entry) playEntry(h.entry, t.closest('[data-hero-play]')); else if (h.mode === 'vod') playItem(h.item, 'vod'); else playSeries(h.item, t.closest('[data-hero-play]')); return; }
  if (h && !h.loading && t.closest('[data-hero-info]')) { openDetail(h.mode, h.item); return; }
  if (t.closest('[data-grid-back]')) { closeGrid(); return; }
  const retry = t.closest('[data-retry]');
  if (retry) { delete B.errors[retry.dataset.retry]; renderBrowse(false); }
});
// frecce delle righe: nascoste all'inizio e alla fine
browsePage.addEventListener('scroll', (ev) => {
  const t = ev.target;
  if (t.classList && t.classList.contains('row-track') && t.parentElement.classList.contains('row-wrap')) updateArrows(t.parentElement);
}, { capture: true, passive: true });
browsePage.addEventListener('mouseover', (ev) => {
  const w = ev.target.closest && ev.target.closest('.row-wrap');
  if (w && w !== B.hoverWrap) { B.hoverWrap = w; updateArrows(w); }
});
// locandina o logo mancante: resta il titolo; sfondo dell'hero mancante: resta il nero
function onImgError(ev) {
  const t = ev.target;
  if (!t || t.tagName !== 'IMG' || !t.parentElement) return;
  const fb = t.parentElement.querySelector('.pcard-fb');
  if (fb) fb.classList.remove('hidden');
  t.remove();
}
browsePage.addEventListener('error', onImgError, true);

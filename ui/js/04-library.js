// Lista della Live TV (categorie, caricamento, ricerca), catalogo condiviso con le viste a righe,
// preferiti e recenti.
'use strict';

// ------------------------------------------------------------------ modalità / categorie
async function switchMode(mode, force) {
  if (!MODES.includes(mode)) return;
  if (mode === S.mode && !force) return;
  S.mode = mode;
  $('cat-search').value = '';
  S.catFilter = '';
  $('stream-search').value = '';
  S.search = '';
  updateSearchClear();
  await loadCategories(false);
  selectCategory(S.selectedCat[mode] || ALL);
}

// categorie di una modalità in S.categories / S.catNames (anche per le viste a righe);
// false se nel frattempo si è chiusa la playlist
async function fetchCategories(mode, forceReload) {
  const acct = S.acct;
  try {
    const res = await invoke('get_categories', { ...S.creds, mode: MODE_API[mode].cats, cache: forceReload ? 'refresh' : 'prefer' });
    if (S.acct !== acct) return false;
    S.categories[mode] = res.items;
    S.catNames[mode] = new Map(res.items.map((c) => [c.category_id, c.category_name]));
  } catch (e) {
    if (S.acct !== acct) return false;
    S.categories[mode] = [];
    toast('Errore categorie: ' + errText(e), 'error');
  }
  return true;
}

async function loadCategories(forceReload) {
  const mode = S.mode;
  if (S.categories[mode] && !forceReload) { renderCategories(); return; }
  $('cat-list').innerHTML = '<div class="flex items-center gap-2 text-sm text-ink-subtle p-3"><svg class="w-4 h-4 spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"/></svg>Caricamento categorie…</div>';
  if (await fetchCategories(mode, forceReload) && S.mode === mode) renderCategories();
}

function renderCategories() {
  const mode = S.mode;
  const cats = S.categories[mode] || [];
  const q = normKey(S.catFilter);
  const sel = S.selectedCat[mode];
  // categorie spuntate quando se ne guardano più insieme
  const picked = new Set(sel === MULTI ? S.multiCats[mode] : []);
  const btn = (attrs, active, name, icon, count, title) => `<button ${attrs} ${active ? 'aria-current="true"' : ''} title="${escapeHtml(title || name)}" class="w-full h-9 text-left px-3 rounded-lg text-sm transition flex items-center gap-2.5 ${active ? 'bg-accent-soft text-accent-ink font-bold' : 'text-ink-muted font-medium hover:bg-s3 hover:text-ink'}">${icon || ''}<span class="truncate flex-1">${escapeHtml(name)}</span>${count != null ? `<span class="text-[11px] font-semibold tabular-nums ${active ? 'text-accent-ink' : 'text-ink-subtle'}">${count}</span>` : ''}</button>`;
  const item = (id, name, icon, count) => btn(`data-cat="${escapeHtml(id)}"`, id === sel, name, icon, count);
  let html = '';
  if (!q) {
    html += item(ALL, MODE_API[mode].allLabel, `<span class="text-ink-subtle">${ICONS.list}</span>`);
    html += item(FAV, 'Preferiti', `<span class="text-accent">${ICONS.star}</span>`, S.favorites[mode].length);
    html += item(RECENT, mode === 'vod' ? 'Visti di recente' : 'Recenti', `<span class="text-info">${ICONS.clock}</span>`, S.recent[mode].length);
    // apre la scelta di più categorie (09b-browse.js); con più categorie attive le riassume
    html += btn(`data-catpick="${mode}" aria-haspopup="dialog" aria-expanded="false"`, picked.size > 0,
      picked.size ? categoryLabel(mode, MULTI) : 'Più categorie…', `<span class="${picked.size ? '' : 'text-ink-subtle'}">${ICONS.checks}</span>`, null,
      picked.size ? multiCatNames(mode).join(', ') : 'Cerca e scegli più categorie da guardare insieme');
    html += '<div class="h-px bg-line my-2"></div>';
  }
  const visible = q ? cats.filter((c) => normKey(c.category_name).includes(q)) : cats;
  html += visible.map((c) => picked.has(String(c.category_id))
    ? btn(`data-cat="${escapeHtml(c.category_id)}"`, false, c.category_name, `<span class="text-accent">${ICONS.check}</span>`)
    : item(c.category_id, c.category_name)).join('');
  if (!visible.length && q) html += '<p class="text-xs text-ink-subtle p-3">Nessuna categoria trovata.</p>';
  if (!cats.length && !q) html += '<p class="text-xs text-ink-subtle p-3">Nessuna categoria disponibile.</p>';
  $('cat-list').innerHTML = html;
}
function revealSelectedCategory() {
  const el = $('cat-list').querySelector('[aria-current="true"]');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

$('cat-list').addEventListener('click', (ev) => {
  const pick = ev.target.closest('[data-catpick]');
  if (pick) { toggleCatPick(pick.dataset.catpick, pick); return; }
  const b = ev.target.closest('[data-cat]');
  if (b) selectCategory(b.dataset.cat);
});
$('cat-search').addEventListener('input', debounce((ev) => { S.catFilter = ev.target.value; renderCategories(); }, 80));

function categoryLabel(mode, id) {
  if (id === ALL) return MODE_API[mode].allLabel;
  if (id === FAV) return 'Preferiti';
  if (id === RECENT) return mode === 'vod' ? 'Visti di recente' : 'Recenti';
  if (id === MULTI) return `${S.multiCats[mode].length} categorie`;
  return S.catNames[mode].get(id) || `Categoria ${id}`;
}
const multiCatNames = (mode) => S.multiCats[mode].map((id) => categoryLabel(mode, id));

async function selectCategory(catId) {
  const mode = S.mode;
  const known = S.categories[mode] && S.categories[mode].length ? (id) => S.catNames[mode].has(id) : () => true;
  if (catId === MULTI) {
    // categorie sparite dal provider dopo un aggiornamento: con una sola rimasta si torna alla scelta singola
    const ids = S.multiCats[mode].filter(known);
    if (ids.length !== S.multiCats[mode].length) { S.multiCats[mode] = ids; lsSet(ak('cats.' + mode), ids); }
    if (ids.length < 2) catId = ids[0] || ALL;
  }
  if (!isVirtualCat(catId) && !known(catId)) catId = ALL;
  S.selectedCat[mode] = catId;
  lsSet(ak('cat.' + mode), catId);
  renderCategories();
  revealSelectedCategory();
  $('list-title').textContent = categoryLabel(mode, catId);
  $('list-title').title = catId === MULTI ? multiCatNames(mode).join(', ') : $('list-title').textContent;
  $('list-clear-recent').classList.toggle('hidden', catId !== RECENT);
  await loadStreams(mode, catId, false);
}

// dal riquadro "Più categorie": con una sola categoria spuntata è la scelta normale
function selectCategories(ids) {
  if (ids.length < 2) return selectCategory(ids[0] || ALL);
  S.multiCats[S.mode] = ids.map(String);
  lsSet(ak('cats.' + S.mode), S.multiCats[S.mode]);
  return selectCategory(MULTI);
}

// ------------------------------------------------------------------ stream
function prepareItems(items) {
  for (const it of items) it._k = normKey(it.name);
  return items;
}

// più categorie insieme: si filtra la lista completa, nell'ordine delle categorie del provider
const multiCatItems = (mode, all) => XPCore.itemsInCategories(all, S.categories[mode], S.multiCats[mode]);

async function loadStreams(mode, catId, forceReload) {
  const seq = ++S.loadSeq;
  const acct = S.acct;
  // con più categorie si carica la lista completa
  const listId = catId === MULTI ? ALL : catId;
  let items;
  if (catId === FAV || catId === RECENT) {
    items = prepareItems((catId === FAV ? S.favorites : S.recent)[mode].slice());
  } else {
    const key = mode + '|' + listId;
    const allKey = mode + '|' + ALL;
    if (!forceReload && S.cache.has(key)) {
      items = S.cache.get(key);
    } else if (!forceReload && listId !== ALL && S.cache.has(allKey)) {
      items = S.cache.get(allKey).filter((s) => s.category_id === listId);
      S.cache.set(key, items);
    } else {
      S.list = []; S.filtered = [];
      renderList(true);
      showListState('loading');
      try {
        // con "prefer" la lista salvata su disco arriva subito; quella aggiornata con l'evento list-updated
        const args = { ...S.creds, categoryId: listId === ALL ? '' : listId, cache: forceReload ? 'refresh' : 'prefer' };
        const res = mode === 'series'
          ? await invoke('get_series_list', args)
          : await invoke('get_streams', { ...args, mode: MODE_API[mode].streams });
        if (S.acct !== acct) return;
        items = prepareItems(res.items);
        S.cache.set(key, items);
        S.listAge.set(key, res.fetched_at);
      } catch (e) {
        if (seq !== S.loadSeq) return;
        showListState('error', errText(e));
        return;
      }
    }
  }
  if (seq !== S.loadSeq) return;
  S.list = catId === MULTI ? multiCatItems(mode, items) : items;
  applyFilter(true);
  locateCurrent(false);
  setListAge(S.listAge.get(mode + '|' + listId));
}

function setListAge(fetchedAt) {
  $('list-count').title = fetchedAt ? 'Lista aggiornata il ' + new Date(fetchedAt * 1000).toLocaleString('it-IT') : '';
}

// La lista salvata su disco è stata riscaricata in background (evento "list-updated"):
// si sostituisce senza perdere scroll, ricerca e contenuto in riproduzione.
function onListUpdated(p) {
  if (!S.creds || !p) return;
  // aggiornamento partito prima di un cambio di playlist
  if (p.server !== S.creds.server || p.username !== S.creds.username) return;
  const mode = Object.keys(MODE_API).find((m) => MODE_API[m].streams === p.action || MODE_API[m].cats === p.action);
  if (!mode) return;
  if (MODE_API[mode].cats === p.action) {
    S.categories[mode] = p.items;
    S.catNames[mode] = new Map(p.items.map((c) => [c.category_id, c.category_name]));
    if (S.mode === mode) renderCategories();
    onCatalogUpdated(mode);
    return;
  }
  const catId = p.category_id || ALL;
  const key = mode + '|' + catId;
  // le sottoliste ricavate in memoria da "tutti" vanno ricalcolate
  if (catId === ALL) for (const k of Array.from(S.cache.keys())) if (k.startsWith(mode + '|') && k !== key) S.cache.delete(k);
  const items = prepareItems(p.items);
  S.cache.set(key, items);
  S.listAge.set(key, p.fetched_at);
  if (catId === ALL) onCatalogUpdated(mode);
  const sel = S.selectedCat[mode];
  if (S.mode !== mode || sel === FAV || sel === RECENT) return;
  if (sel !== catId && catId !== ALL) return;
  let list = items;
  if (sel === MULTI) list = multiCatItems(mode, items);
  else if (sel !== catId) { list = items.filter((s) => s.category_id === sel); S.cache.set(mode + '|' + sel, list); }
  const before = S.list.length;
  S.list = list;
  applyFilter(false);
  setListAge(p.fetched_at);
  if (list.length !== before) toast(`Lista aggiornata: ${list.length.toLocaleString('it-IT')} ${MODE_API[mode].unit}`);
}

function searchTerms() { return normKey(S.search).split(/\s+/).filter(Boolean); }

function applyFilter(resetScroll) {
  const terms = searchTerms();
  S.filtered = terms.length ? S.list.filter((it) => terms.every((t) => it._k.includes(t))) : S.list;
  const unit = MODE_API[S.mode].unit;
  $('list-count').textContent = terms.length ? `${S.filtered.length.toLocaleString('it-IT')} / ${S.list.length.toLocaleString('it-IT')} ${unit}` : `${S.list.length.toLocaleString('it-IT')} ${unit}`;
  if (resetScroll) $('list-scroller').scrollTop = 0;
  if (!S.filtered.length) {
    const cat = S.selectedCat[S.mode];
    const unitOne = { vod: 'un film', series: 'una serie' }[S.mode] || 'un canale';
    showListState('empty', terms.length
      ? `Nessun risultato per “${S.search.trim()}”.` + (cat === MULTI ? ' La ricerca riguarda solo le categorie selezionate.' : cat !== ALL ? ' La ricerca riguarda solo la categoria selezionata.' : '')
      : cat === FAV ? `Nessun preferito: passa sopra ${unitOne} e premi la stella.`
      : cat === RECENT ? `Qui compariranno gli ultimi ${MODE_API[S.mode].unit} che apri.`
      : 'Nessun elemento in questa categoria.', terms.length && cat !== ALL);
  } else {
    showListState(null);
  }
  renderList(true);
  updateLocateButton();
  onGuideListChanged(resetScroll);
}

function currentIndex() {
  if (!S.current || S.currentMode !== S.mode) return -1;
  return S.filtered.findIndex((s) => s.stream_id === S.current.stream_id);
}
function updateLocateButton() { $('list-locate').classList.toggle('hidden', currentIndex() === -1); }
// porta al centro della lista il contenuto in riproduzione
function locateCurrent(always) {
  const idx = currentIndex();
  if (idx === -1) return;
  const top = idx * ROW_H, h = scroller.clientHeight;
  if (always || top < scroller.scrollTop || top + ROW_H > scroller.scrollTop + h) {
    scroller.scrollTop = Math.max(0, top - (h - ROW_H) / 2);
  }
}
$('list-locate').addEventListener('click', () => locateCurrent(true));

function showListState(kind, msg, searchAll) {
  const el = $('list-state');
  if (!kind) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  if (kind === 'loading') {
    el.innerHTML = '<svg class="w-8 h-8 text-accent spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"/></svg><span>Caricamento lista… (con molti elementi può richiedere qualche secondo)</span>';
  } else if (kind === 'error') {
    el.innerHTML = `<svg class="w-8 h-8 text-danger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/></svg><span class="text-danger">${escapeHtml(msg)}</span><button id="list-retry" class="btn btn-secondary btn-sm">Riprova</button>`;
    $('list-retry').addEventListener('click', () => loadStreams(S.mode, S.selectedCat[S.mode], true));
  } else {
    el.innerHTML = `<span>${escapeHtml(msg)}</span>` +
      (searchAll ? `<button id="list-search-all" class="btn btn-secondary btn-sm">Cerca in ${escapeHtml(MODE_API[S.mode].allLabel.toLowerCase())}</button>` : '');
    if (searchAll) $('list-search-all').addEventListener('click', () => selectCategory(ALL));
  }
}

function updateSearchClear() {
  $('stream-search-clear').classList.toggle('hidden', !S.search);
  $('stream-search-kbd').classList.toggle('hidden', !!S.search);
}
function clearSearch() {
  $('stream-search').value = ''; S.search = '';
  updateSearchClear();
  applyFilter(true);
  locateCurrent(false);
}
const onSearch = debounce(() => { applyFilter(true); }, 70);
$('stream-search').addEventListener('input', (ev) => {
  S.search = ev.target.value;
  updateSearchClear();
  onSearch();
});
$('stream-search-clear').addEventListener('click', () => { clearSearch(); $('stream-search').focus(); });

// ------------------------------------------------------------------ aggiornamento delle liste
// Categorie e liste complete di Live TV, film e serie riscaricate dal provider: a mano (pulsante in
// alto, menu dell'account) e da sole una volta al giorno, anche all'avvio se l'ultimo aggiornamento
// risale a più di un giorno prima. Le liste aperte si aggiornano restando dov'erano (onListUpdated).
const LISTS_EVERY_MS = 24 * 3600000;
let listsJob = null;

function refreshLists(manual) {
  if (!S.creds) return Promise.resolve(false);
  if (listsJob) return listsJob;
  const acct = S.acct, creds = S.creds;
  const send = (action, res) => onListUpdated({ server: creds.server, username: creds.username, action, category_id: '', items: res.items, fetched_at: res.fetched_at });
  // prima la sezione aperta, poi le altre una alla volta (meno carico per il provider e il dispositivo)
  const order = Array.from(new Set([S.view, 'live', 'vod', 'series'])).filter((m) => MODES.includes(m));
  setListsBusy(true);
  listsJob = (async () => {
    let failed = '';
    for (const mode of order) {
      try {
        const cats = await invoke('get_categories', { ...creds, mode: MODE_API[mode].cats, cache: 'refresh' });
        if (S.acct !== acct) return false;
        send(MODE_API[mode].cats, cats);
        const args = { ...creds, categoryId: '', cache: 'refresh' };
        const res = mode === 'series' ? await invoke('get_series_list', args) : await invoke('get_streams', { ...args, mode: MODE_API[mode].streams });
        if (S.acct !== acct) return false;
        send(MODE_API[mode].streams, res);
        delete B.errors[mode];
      } catch (e) {
        if (S.acct !== acct) return false;
        failed = failed || errText(e);
      }
    }
    // non riuscito: il controllo periodico riprova più tardi
    if (failed) {
      if (manual) toast('Aggiornamento delle liste non riuscito: ' + failed, 'error');
      return false;
    }
    lsSet(ak('listsAt'), Date.now());
    renderListsAge();
    if (manual) toast('Liste aggiornate', 'ok');
    return true;
  })().finally(() => { listsJob = null; setListsBusy(false); });
  return listsJob;
}

function maybeRefreshLists() {
  if (!S.creds || listsJob) return;
  const last = lsGet(ak('listsAt'), 0);
  // prima volta con questa versione: le liste si sono appena caricate, si conta da adesso
  if (!last) { lsSet(ak('listsAt'), Date.now()); renderListsAge(); return; }
  if (XPCore.refreshDue(last, Date.now(), LISTS_EVERY_MS)) refreshLists(false);
}
setInterval(maybeRefreshLists, 15 * 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeRefreshLists(); });

function setListsBusy(busy) {
  for (const id of ['refresh-btn', 'acct-refresh']) {
    const b = $(id);
    b.disabled = busy;
    b.querySelector('svg').classList.toggle('spin', busy);
  }
}

function renderListsAge() {
  const at = S.creds ? lsGet(ak('listsAt'), 0) : 0;
  const el = $('lists-age');
  if (!at) { el.textContent = ''; return; }
  const d = new Date(at), now = new Date();
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const day = d.toDateString() === now.toDateString() ? 'oggi'
    : d.toDateString() === yesterday.toDateString() ? 'ieri'
    : d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
  el.textContent = `Liste aggiornate ${day} alle ${time}`;
  el.title = 'Si aggiornano da sole una volta al giorno';
}

$('refresh-btn').addEventListener('click', () => refreshLists(true));
$('acct-refresh').addEventListener('click', () => refreshLists(true));

$('list-clear-recent').addEventListener('click', () => {
  const mode = S.mode;
  S.recent[mode] = [];
  lsSet(ak('recent.' + mode), []);
  renderCategories();
  if (S.selectedCat[mode] === RECENT) { S.list = []; applyFilter(true); }
});

// ------------------------------------------------------------------ preferiti
function favIndex(mode, id) { return S.favorites[mode].findIndex((f) => f.stream_id === id); }
function isFav(mode, id) { return favIndex(mode, id) !== -1; }
function slimItem(item) {
  return {
    stream_id: item.stream_id, name: item.name, stream_icon: item.stream_icon, category_id: item.category_id,
    container_extension: item.container_extension, num: item.num, epg_channel_id: item.epg_channel_id, rating: item.rating,
    tv_archive: item.tv_archive, tv_archive_duration: item.tv_archive_duration, genre: item.genre, release_date: item.release_date,
  };
}
function toggleFav(mode, item) {
  const i = favIndex(mode, item.stream_id);
  const added = i === -1;
  if (added) S.favorites[mode].push(slimItem(item));
  else S.favorites[mode].splice(i, 1);
  lsSet(ak('fav.' + mode), S.favorites[mode]);
  if (S.mode === mode) {
    renderCategories();
    if (S.selectedCat[mode] === FAV) { S.list = prepareItems(S.favorites[mode].slice()); applyFilter(false); } else renderList(true);
  }
  updateFavButton();
  onFavChanged();
  toast(added ? `“${item.name}” aggiunto ai preferiti` : `“${item.name}” rimosso dai preferiti`, added ? 'ok' : undefined);
}

// cronologia: la lista "Recenti" aperta non viene riordinata, così ↑/↓ restano prevedibili
function pushRecent(mode, item) {
  const list = S.recent[mode].filter((r) => r.stream_id !== item.stream_id);
  list.unshift(slimItem(item));
  S.recent[mode] = list.slice(0, RECENT_MAX);
  lsSet(ak('recent.' + mode), S.recent[mode]);
  if (S.mode === mode) renderCategories();
}

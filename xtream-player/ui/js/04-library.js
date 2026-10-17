// Modalità Live/Film, categorie, caricamento liste, ricerca, preferiti e recenti.
'use strict';

// ------------------------------------------------------------------ modalità / categorie
function updateModeButtons() {
  document.querySelectorAll('.mode-btn').forEach((b) => {
    const active = b.dataset.mode === S.mode;
    b.className = 'mode-btn text-sm font-medium py-1.5 rounded-md transition ' +
      (active ? 'bg-ink text-s1' : 'text-ink-muted hover:text-ink hover:bg-s3');
    b.setAttribute('aria-selected', String(active));
  });
  $('stream-search').placeholder = { vod: 'Cerca film', series: 'Cerca serie' }[S.mode] || 'Cerca canale';
}
document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode)));

async function switchMode(mode, force) {
  if (!MODES.includes(mode)) return;
  if (mode === S.mode && !force) return;
  closeSeries();
  S.mode = mode;
  lsSet('xp.mode', mode);
  updateModeButtons();
  $('cat-search').value = '';
  S.catFilter = '';
  $('stream-search').value = '';
  S.search = '';
  updateSearchClear();
  await loadCategories(false);
  selectCategory(S.selectedCat[mode] || ALL);
}

async function loadCategories(forceReload) {
  const mode = S.mode;
  if (S.categories[mode] && !forceReload) { renderCategories(); return; }
  $('cat-list').innerHTML = '<div class="flex items-center gap-2 text-sm text-ink-subtle p-3"><svg class="w-4 h-4 spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"/></svg>Caricamento categorie…</div>';
  try {
    const res = await invoke('get_categories', { ...S.creds, mode: MODE_API[mode].cats, cache: forceReload ? 'refresh' : 'prefer' });
    const cats = res.items;
    S.categories[mode] = cats;
    const map = new Map();
    cats.forEach((c) => map.set(c.category_id, c.category_name));
    S.catNames[mode] = map;
  } catch (e) {
    S.categories[mode] = [];
    toast('Errore categorie: ' + errText(e), 'error');
  }
  if (S.mode === mode) renderCategories();
}

function renderCategories() {
  const mode = S.mode;
  const cats = S.categories[mode] || [];
  const q = normKey(S.catFilter);
  const sel = S.selectedCat[mode];
  const item = (id, name, icon, count) => {
    const active = id === sel;
    return `<button data-cat="${escapeHtml(id)}" ${active ? 'aria-current="true"' : ''} title="${escapeHtml(name)}" class="w-full h-9 text-left px-3 rounded-lg text-sm transition flex items-center gap-2.5 ${active ? 'bg-accent-soft text-accent-ink font-bold' : 'text-ink-muted font-medium hover:bg-s3 hover:text-ink'}">${icon || ''}<span class="truncate flex-1">${escapeHtml(name)}</span>${count != null ? `<span class="text-[11px] font-semibold tabular-nums ${active ? 'text-accent-ink' : 'text-ink-subtle'}">${count}</span>` : ''}</button>`;
  };
  let html = '';
  if (!q) {
    html += item(ALL, MODE_API[mode].allLabel, `<span class="text-ink-subtle">${ICONS.list}</span>`);
    html += item(FAV, 'Preferiti', `<span class="text-accent">${ICONS.star}</span>`, S.favorites[mode].length);
    html += item(RECENT, mode === 'vod' ? 'Visti di recente' : 'Recenti', `<span class="text-info">${ICONS.clock}</span>`, S.recent[mode].length);
    html += '<div class="h-px bg-line my-2"></div>';
  }
  const visible = q ? cats.filter((c) => normKey(c.category_name).includes(q)) : cats;
  html += visible.map((c) => item(c.category_id, c.category_name)).join('');
  if (!visible.length && q) html += '<p class="text-xs text-ink-subtle p-3">Nessuna categoria trovata.</p>';
  if (!cats.length && !q) html += '<p class="text-xs text-ink-subtle p-3">Nessuna categoria disponibile.</p>';
  $('cat-list').innerHTML = html;
}
function revealSelectedCategory() {
  const el = $('cat-list').querySelector('[aria-current="true"]');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

$('cat-list').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-cat]');
  if (b) selectCategory(b.dataset.cat);
});
$('cat-search').addEventListener('input', debounce((ev) => { S.catFilter = ev.target.value; renderCategories(); }, 80));

function categoryLabel(mode, id) {
  if (id === ALL) return MODE_API[mode].allLabel;
  if (id === FAV) return 'Preferiti';
  if (id === RECENT) return mode === 'vod' ? 'Visti di recente' : 'Recenti';
  return S.catNames[mode].get(id) || `Categoria ${id}`;
}

async function selectCategory(catId) {
  const mode = S.mode;
  if (!isVirtualCat(catId) && S.categories[mode] && S.categories[mode].length && !S.catNames[mode].has(catId)) catId = ALL;
  S.selectedCat[mode] = catId;
  lsSet('xp.cat.' + mode, catId);
  renderCategories();
  revealSelectedCategory();
  $('list-title').textContent = categoryLabel(mode, catId);
  $('list-title').title = $('list-title').textContent;
  $('list-clear-recent').classList.toggle('hidden', catId !== RECENT);
  await loadStreams(mode, catId, false);
}

// ------------------------------------------------------------------ stream
function prepareItems(items) {
  for (const it of items) it._k = normKey(it.name);
  return items;
}

async function loadStreams(mode, catId, forceReload) {
  const seq = ++S.loadSeq;
  let items;
  if (catId === FAV || catId === RECENT) {
    items = prepareItems((catId === FAV ? S.favorites : S.recent)[mode].slice());
  } else {
    const key = mode + '|' + catId;
    const allKey = mode + '|' + ALL;
    if (!forceReload && S.cache.has(key)) {
      items = S.cache.get(key);
    } else if (!forceReload && catId !== ALL && S.cache.has(allKey)) {
      items = S.cache.get(allKey).filter((s) => s.category_id === catId);
      S.cache.set(key, items);
    } else {
      S.list = []; S.filtered = [];
      renderList(true);
      showListState('loading');
      try {
        // con "prefer" la lista salvata su disco arriva subito; quella aggiornata con l'evento list-updated
        const args = { ...S.creds, categoryId: catId === ALL ? '' : catId, cache: forceReload ? 'refresh' : 'prefer' };
        const res = mode === 'series'
          ? await invoke('get_series_list', args)
          : await invoke('get_streams', { ...args, mode: MODE_API[mode].streams });
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
  S.list = items;
  applyFilter(true);
  locateCurrent(false);
  setListAge(S.listAge.get(mode + '|' + catId));
}

function setListAge(fetchedAt) {
  $('list-count').title = fetchedAt ? 'Lista aggiornata il ' + new Date(fetchedAt * 1000).toLocaleString('it-IT') : '';
}

// La lista salvata su disco è stata riscaricata in background (evento "list-updated"):
// si sostituisce senza perdere scroll, ricerca e contenuto in riproduzione.
function onListUpdated(p) {
  if (!S.creds || !p) return;
  const mode = Object.keys(MODE_API).find((m) => MODE_API[m].streams === p.action || MODE_API[m].cats === p.action);
  if (!mode) return;
  if (MODE_API[mode].cats === p.action) {
    S.categories[mode] = p.items;
    S.catNames[mode] = new Map(p.items.map((c) => [c.category_id, c.category_name]));
    if (S.mode === mode) renderCategories();
    return;
  }
  const catId = p.category_id || ALL;
  const key = mode + '|' + catId;
  // le sottoliste ricavate in memoria da "tutti" vanno ricalcolate
  if (catId === ALL) for (const k of Array.from(S.cache.keys())) if (k.startsWith(mode + '|') && k !== key) S.cache.delete(k);
  const items = prepareItems(p.items);
  S.cache.set(key, items);
  S.listAge.set(key, p.fetched_at);
  const sel = S.selectedCat[mode];
  if (S.mode !== mode || (isVirtualCat(sel) && sel !== ALL)) return;
  if (sel !== catId && catId !== ALL) return;
  const list = sel === catId ? items : items.filter((s) => s.category_id === sel);
  if (sel !== catId) S.cache.set(mode + '|' + sel, list);
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
      ? `Nessun risultato per “${S.search.trim()}”.` + (cat !== ALL ? ' La ricerca riguarda solo la categoria selezionata.' : '')
      : cat === FAV ? `Nessun preferito: passa sopra ${unitOne} e premi la stella.`
      : cat === RECENT ? `Qui compariranno gli ultimi ${MODE_API[S.mode].unit} che apri.`
      : 'Nessun elemento in questa categoria.', terms.length && cat !== ALL);
  } else {
    showListState(null);
  }
  renderList(true);
  updateLocateButton();
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

$('refresh-btn').addEventListener('click', async () => {
  const btn = $('refresh-btn');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.querySelector('svg').classList.add('spin');
  const mode = S.mode;
  try {
    for (const k of Array.from(S.cache.keys())) if (k.startsWith(mode + '|')) S.cache.delete(k);
    await loadCategories(true);
    await loadStreams(mode, S.selectedCat[mode], true);
    toast('Liste aggiornate', 'ok');
  } finally {
    btn.disabled = false;
    btn.querySelector('svg').classList.remove('spin');
  }
});

$('list-clear-recent').addEventListener('click', () => {
  const mode = S.mode;
  S.recent[mode] = [];
  lsSet('xp.recent.' + mode, []);
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
  lsSet('xp.fav.' + mode, S.favorites[mode]);
  if (S.mode === mode) {
    renderCategories();
    if (S.selectedCat[mode] === FAV) { S.list = prepareItems(S.favorites[mode].slice()); applyFilter(false); } else renderList(true);
  }
  updateFavButton();
  toast(added ? `“${item.name}” aggiunto ai preferiti` : `“${item.name}” rimosso dai preferiti`, added ? 'ok' : undefined);
}

// cronologia: la lista "Recenti" aperta non viene riordinata, così ↑/↓ restano prevedibili
function pushRecent(mode, item) {
  const list = S.recent[mode].filter((r) => r.stream_id !== item.stream_id);
  list.unshift(slimItem(item));
  S.recent[mode] = list.slice(0, RECENT_MAX);
  lsSet('xp.recent.' + mode, S.recent[mode]);
  if (S.mode === mode) renderCategories();
}

// Categorie personalizzate e gruppi personali, per playlist e sezione: categorie nascoste,
// rinominate e riordinate, gruppi con canali, film o serie presi da categorie diverse.
// Si modificano nella pagina "Categorie e gruppi" (dal menu dell'account, dalla matita della
// colonna delle categorie e da "Modifica" nel riquadro delle categorie); un singolo contenuto si
// aggiunge ai gruppi anche dalla scheda e dal pannello del canale in riproduzione. La logica pura
// è in core.js. I dati stanno in
//   xp.a.<acct>.custom.<mode>       { hidden, names, order, groups }
//   xp.a.<acct>.group.<mode>.<id>   elementi del gruppo (come i preferiti)
// e si sincronizzano tra i dispositivi come preferiti e recenti (09d-sync.js).
'use strict';

const GROUP_MAX = 500;
const customKey = (mode) => ak('custom.' + mode);
const groupKey = (mode, id) => ak(`group.${mode}.${String(id).slice(2)}`);
const isGroupId = XPCore.isGroupId;
const groupItems = (mode, id) => S.groups[mode].get(String(id)) || [];

const CE_ICONS = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  grip: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
  folder: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  folderPlus: '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/></svg>',
};

// ------------------------------------------------------------------ dati
// personalizzazioni e gruppi della playlist aperta (all'accesso e dopo una sincronizzazione)
function reloadCustom() {
  for (const m of MODES) {
    S.custom[m] = XPCore.normalizeCustom(lsGet(customKey(m), null));
    S.groups[m] = new Map(S.custom[m].groups.map((g) => {
      const v = lsGet(groupKey(m, g.id), []);
      return [g.id, Array.isArray(v) ? v : []];
    }));
  }
}

// categorie da mostrare e nomi (anche delle nascoste: sottotitoli di preferiti e recenti)
function applyCustom(mode) {
  const raw = S.rawCategories[mode];
  if (!raw) return;
  S.categories[mode] = XPCore.customCategories(raw, S.custom[mode]);
  S.catNames[mode] = new Map(XPCore.editableCategories(raw, S.custom[mode]).map((c) => [c.category_id, c.category_name]));
}

// elementi di una lista completa senza quelli delle categorie nascoste
const visibleItems = (mode, items) => XPCore.withoutHidden(items, S.custom[mode]);

function saveCustom(mode, next) {
  S.custom[mode] = XPCore.normalizeCustom(next);
  if (XPCore.isEmptyCustom(S.custom[mode])) lsDel(customKey(mode));
  else lsSet(customKey(mode), S.custom[mode]);
}
function saveGroup(mode, id, list) {
  S.groups[mode].set(id, list);
  if (list.length) lsSet(groupKey(mode, id), list.map(slimItem));
  else lsDel(groupKey(mode, id));
}

// categorie o gruppi cambiati (qui o da un altro dispositivo): si ridisegna quello che li mostra
function onCustomChanged(mode) {
  applyCustom(mode);
  if (mode === S.mode && S.liveReady && S.categories[mode]) {
    renderCategories();
    refreshCurrentList(mode);
  }
  if (browseVisible()) renderBrowse(false);
  if (catpickOpen() && CP.mode === mode) renderCatPick();
  updateDetailActions();
  updateGroupButton();
  if (customOpen() && CV.mode === mode) renderCustom();
}

// lista della Live TV aperta: categoria nascosta o gruppo eliminato -> si torna a "tutti";
// altrimenti si ricalcola restando dov'era
function refreshCurrentList(mode) {
  const sel = S.selectedCat[mode];
  const shown = new Set((S.categories[mode] || []).map((c) => String(c.category_id)));
  if (!isVirtualCat(sel) && !shown.has(String(sel))) { selectCategory(ALL); return; }
  $('list-title').textContent = categoryLabel(mode, sel);
  if (isGroupId(sel)) {
    S.list = prepareItems(groupItems(mode, sel).slice());
  } else if (sel === ALL || sel === MULTI) {
    const all = S.cache.get(mode + '|' + ALL);
    if (!all) { renderList(true); return; }
    S.list = sel === MULTI ? multiCatItems(mode, all) : visibleItems(mode, all);
  } else { renderList(true); return; }
  applyFilter(false);
}

// ------------------------------------------------------------------ azioni
function newGroupId() {
  const b = crypto.getRandomValues(new Uint8Array(4));
  return 'u:' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

// nome scritto in una finestra; null se annullata
async function askName(title, help, value, extra) {
  const v = await openModal(title,
    `${help ? `<p>${help}</p>` : ''}<input id="cedit-name" maxlength="60" autocomplete="off" spellcheck="false" class="field mt-3" value="${escapeHtml(value || '')}">`,
    [{ label: 'Annulla', value: false }].concat(extra || [], [{ label: 'Salva', value: 'save', primary: true }]));
  if (v !== 'save') return v || null;
  return ($('cedit-name') && $('cedit-name').value.trim()) || '';
}
// nella finestra del nome: Invio salva
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target && ev.target.id === 'cedit-name') { ev.preventDefault(); closeModal('save'); }
});
// il campo del nome prende lo stato attivo all'apertura
function focusNameField() {
  const f = $('cedit-name');
  if (f) { f.focus(); f.select(); }
}

function addGroup(mode, name) {
  const id = newGroupId();
  const c = S.custom[mode];
  saveCustom(mode, { ...c, groups: c.groups.concat({ id, name }) });
  S.groups[mode].set(id, []);
  return id;
}

async function createGroup(mode) {
  const p = askName('Nuovo gruppo', `Un gruppo raccoglie ${MODE_API[mode].unit} di categorie diverse e compare insieme alle categorie.`, '');
  focusNameField();
  const name = await p;
  if (name == null || name === false) return null;
  if (!name) { toast('Scrivi un nome per il gruppo', 'error'); return null; }
  return addGroup(mode, name);
}

async function renameEntry(mode, e) {
  const extra = !e.group && e.category_name !== e.original ? [{ label: 'Nome originale', value: 'orig' }] : [];
  const p = askName(e.group ? 'Rinomina il gruppo' : 'Rinomina la categoria',
    e.group ? '' : `Nome del provider: <b class="text-ink">${escapeHtml(e.original)}</b>`, e.category_name, extra);
  focusNameField();
  const v = await p;
  if (v == null || v === false) return false;
  const c = S.custom[mode];
  if (e.group) {
    if (!v || v === 'orig') return false;
    saveCustom(mode, { ...c, groups: c.groups.map((g) => (g.id === e.category_id ? { ...g, name: v } : g)) });
    return true;
  }
  const names = { ...c.names };
  if (v === 'orig' || !v || v === e.original) delete names[e.category_id];
  else names[e.category_id] = v;
  saveCustom(mode, { ...c, names });
  return true;
}

async function deleteGroup(mode, e) {
  const n = groupItems(mode, e.category_id).length, unit = MODE_API[mode].unit;
  const ok = await openModal('Elimina il gruppo',
    `<p>Il gruppo <b class="text-ink">${escapeHtml(e.category_name)}</b>${n ? ` (${n} ${unit})` : ''} viene eliminato su tutti i dispositivi sincronizzati. ${unit[0].toUpperCase() + unit.slice(1)} e categorie del provider restano.</p>`,
    [{ label: 'Annulla', value: false }, { label: 'Elimina', value: true, danger: true }]);
  if (!ok) return false;
  const c = S.custom[mode], id = e.category_id;
  const names = { ...c.names };
  delete names[id];
  saveCustom(mode, { hidden: c.hidden.filter((x) => x !== id), names, order: c.order.filter((x) => x !== id), groups: c.groups.filter((g) => g.id !== id) });
  saveGroup(mode, id, []);
  S.groups[mode].delete(id);
  return true;
}

async function resetCustom(mode) {
  const ok = await openModal('Ripristina le categorie',
    `<p>Tornano tutte le categorie di ${escapeHtml(MODE_API[mode].label)} con i nomi e l'ordine del provider, su tutti i dispositivi sincronizzati. I gruppi personali restano.</p>`,
    [{ label: 'Annulla', value: false }, { label: 'Ripristina', value: true, primary: true }]);
  if (!ok) return false;
  saveCustom(mode, { groups: S.custom[mode].groups });
  return true;
}

// tutte le voci della sezione (categorie del provider e gruppi), nascoste comprese, nell'ordine scelto
const editEntries = (mode) => XPCore.editableCategories(S.rawCategories[mode] || [], S.custom[mode]);

async function customAction(mode, act, id) {
  const c = S.custom[mode];
  const all = editEntries(mode);
  const e = all.find((x) => x.category_id === String(id));
  if (!e) return false;
  const ids = all.map((x) => x.category_id);
  switch (act) {
    case 'hide':
      saveCustom(mode, { ...c, hidden: e.hidden ? c.hidden.filter((x) => x !== e.category_id) : c.hidden.concat(e.category_id) });
      return true;
    case 'up': case 'down':
      saveCustom(mode, { ...c, order: XPCore.moveId(ids, e.category_id, act === 'up' ? -1 : 1) });
      return true;
    case 'top': case 'bottom':
      saveCustom(mode, { ...c, order: XPCore.moveIdTo(ids, e.category_id, act === 'top' ? ids[0] : ids[ids.length - 1], act === 'bottom') });
      return true;
    case 'orig': {
      const names = { ...c.names };
      delete names[e.category_id];
      saveCustom(mode, { ...c, names });
      return true;
    }
    case 'rename': return renameEntry(mode, e);
    case 'delete': return e.group ? deleteGroup(mode, e) : false;
    default: return false;
  }
}

// ------------------------------------------------------------------ elementi nei gruppi
const inGroup = (mode, id, item) => groupItems(mode, id).some((x) => String(x.stream_id) === String(item.stream_id));
function toggleGroupItem(mode, id, item, on) {
  const list = groupItems(mode, id);
  const has = inGroup(mode, id, item);
  if (on === has) return false;
  if (on && list.length >= GROUP_MAX) { toast(`Un gruppo può contenere al massimo ${GROUP_MAX} elementi`, 'error'); return false; }
  saveGroup(mode, id, on ? list.concat(slimItem(item)) : list.filter((x) => String(x.stream_id) !== String(item.stream_id)));
  return true;
}
const groupsOf = (mode, item) => S.custom[mode].groups.filter((g) => inGroup(mode, g.id, item));

// finestra con i gruppi della sezione da spuntare e il campo per crearne uno nuovo
async function openGroupPicker(mode, item) {
  const groups = S.custom[mode].groups;
  const inside = new Set(groupsOf(mode, item).map((g) => g.id));
  const opts = groups.map((g) => `<button type="button" class="menu-opt${inside.has(g.id) ? ' on' : ''}" data-gpick="${escapeHtml(g.id)}" aria-pressed="${inside.has(g.id)}">
      <span class="cp-box">${CP_CHECK}</span><span class="truncate min-w-0 flex-1">${escapeHtml(g.name)}</span><small class="tabular-nums">${groupItems(mode, g.id).length}</small></button>`).join('');
  const ok = await openModal(`Gruppi di “${item.name}”`,
    `<div class="gpick space-y-0.5 max-h-[40vh] overflow-y-auto">${opts || '<p class="text-sm text-ink-subtle">Nessun gruppo: creane uno qui sotto.</p>'}</div>
     <input id="gpick-new" maxlength="60" autocomplete="off" spellcheck="false" placeholder="Nuovo gruppo…" class="field field-sm mt-3" aria-label="Nome di un nuovo gruppo">
     <p class="mt-3 text-xs text-ink-subtle">Per ordinare o svuotare i gruppi: menu dell'account › Categorie e gruppi.</p>`,
    [{ label: 'Annulla', value: false }, { label: 'Fatto', value: true, primary: true }]);
  if (!ok) return;
  const picked = new Set(Array.from($('modal-body').querySelectorAll('[data-gpick].on'), (b) => b.dataset.gpick));
  const newName = ($('gpick-new') && $('gpick-new').value.trim()) || '';
  let changed = false;
  for (const g of groups) changed = toggleGroupItem(mode, g.id, item, picked.has(g.id)) || changed;
  if (newName) {
    toggleGroupItem(mode, addGroup(mode, newName), item, true);
    changed = true;
  }
  if (!changed) return;
  onCustomChanged(mode);
  const now = groupsOf(mode, item).map((g) => g.name);
  toast(now.length ? `“${item.name}” in: ${now.join(', ')}` : `“${item.name}” non è più in nessun gruppo`, 'ok');
}
$('modal-body').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-gpick]');
  if (!b) return;
  const on = !b.classList.contains('on');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target && ev.target.id === 'gpick-new') { ev.preventDefault(); closeModal(true); }
});

// pannello del contenuto in riproduzione: canale o film nei gruppi
function updateGroupButton() {
  const b = $('btn-group');
  const t = favTarget();
  b.disabled = !t;
  const n = t ? groupsOf(t.mode, t.item).length : 0;
  b.innerHTML = `<span class="${n ? 'text-info' : ''}">${n ? CE_ICONS.folder : CE_ICONS.folderPlus}</span>${n ? `In ${n} grupp${n === 1 ? 'o' : 'i'}` : 'Aggiungi a un gruppo'}`;
  b.title = n ? 'Nei gruppi: ' + groupsOf(t.mode, t.item).map((g) => g.name).join(', ') : 'Aggiungi a un gruppo personale';
}
$('btn-group').addEventListener('click', () => { const t = favTarget(); if (t) openGroupPicker(t.mode, t.item); });

// ------------------------------------------------------------------ pagina "Categorie e gruppi"
const cview = $('custom-view'), cvList = $('cv-list'), cvItems = $('cv-items'), cvSearch = $('cv-search'), cvQ = $('cv-q');
// mode: sezione mostrata; sel: voce aperta a destra; show: filtro dell'elenco ('all' | 'hidden' |
// 'groups'); target: gruppo in cui si aggiungono gli elementi di una categoria; shown: elementi
// disegnati a destra per id; drag: voce trascinata
const CV = { mode: 'live', sel: null, show: 'all', target: null, shown: new Map(), drag: null, counts: null, returnFocus: null };
const customOpen = () => !cview.classList.contains('hidden');
const ITEMS_MAX = 300, ADD_MAX = 40;
// trascinamento con il mouse; su telefono e TV le frecce
const canDrag = () => !PLATFORM.android;
const isMobile = () => document.documentElement.classList.contains('mobile');
const cvLoading = (t) => `<div class="flex items-center gap-2 text-sm text-ink-subtle p-3"><svg class="w-4 h-4 spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"/></svg>${escapeHtml(t)}</div>`;
const cvEmpty = (t) => `<p class="text-sm text-ink-subtle px-2 py-3">${t}</p>`;
const ibtn = (act, label, svg, dis) => `<button type="button" class="cv-ibtn" data-cv="${act}" title="${label}" aria-label="${label}"${dis ? ' disabled' : ''}>${svg}</button>`;
const eyeSvg = (hidden) => (hidden ? ICONS.eyeOff : ICONS.eye).replace(/class="[^"]*"/, '');

function openCustom(mode, sel) {
  if (!S.creds) return;
  closeCatPick(false);
  closeAcctMenu();
  CV.returnFocus = document.activeElement;
  cview.classList.remove('hidden', 'cv-pane-open');
  showCustomMode(MODES.includes(mode) ? mode : 'live', sel && !isVirtualCat(sel) ? String(sel) : null);
  const first = CV.sel && cvList.querySelector(`[data-cv-id="${CSS.escape(CV.sel)}"] [data-cv="select"]`);
  (first || cvSearch).focus({ preventScroll: true });
  if (first) first.scrollIntoView({ block: 'center' });
}
function closeCustom() {
  if (!customOpen()) return;
  cview.classList.add('hidden');
  const r = CV.returnFocus;
  CV.returnFocus = null;
  if (r && document.contains(r) && r.focus) r.focus({ preventScroll: true });
}
// Esc / Indietro: prima il campo di ricerca, poi (telefono) la voce aperta, poi la pagina
function customBack() {
  const a = document.activeElement;
  if (a && (a === cvSearch || a === cvQ) && a.value) { a.value = ''; renderCustom(); return; }
  if (isMobile() && cview.classList.contains('cv-pane-open')) { closeCustomPane(); return; }
  closeCustom();
}
function closeCustomPane() {
  cview.classList.remove('cv-pane-open');
  const r = CV.sel && cvList.querySelector(`[data-cv-id="${CSS.escape(CV.sel)}"] [data-cv="select"]`);
  if (r) r.focus({ preventScroll: true });
}

function showCustomMode(mode, sel) {
  CV.mode = mode;
  CV.sel = sel || null;
  CV.show = 'all';
  cvSearch.value = '';
  cvQ.value = '';
  renderCustom();
  // categorie e catalogo completo della sezione: conteggi, elementi delle categorie, ricerca
  if (!S.rawCategories[mode] || !rawCatalog(mode)) {
    ensureCatalog(mode).then(() => { if (customOpen() && CV.mode === mode) renderCustom(); });
  }
}

function catCounts(mode) {
  const items = rawCatalog(mode);
  if (!items) return null;
  if (CV.counts && CV.counts.items === items) return CV.counts.map;
  const map = new Map();
  for (const it of items) { const k = String(it.category_id); map.set(k, (map.get(k) || 0) + 1); }
  CV.counts = { items, map };
  return map;
}
const entryCount = (mode, e, counts) => (e.group ? groupItems(mode, e.category_id).length : counts ? counts.get(e.category_id) || 0 : null);

function listedEntries(all) {
  const terms = normKey(cvSearch.value).split(/\s+/).filter(Boolean);
  return all.filter((e) => (CV.show === 'hidden' ? e.hidden : CV.show === 'groups' ? e.group : true)
    && (!terms.length || terms.every((t) => normKey(`${e.category_name} ${e.original || ''}`).includes(t))));
}

// stato attivo e scorrimento restano dov'erano quando la pagina si ridisegna
function cvFocusKey() {
  const a = document.activeElement;
  if (!a || !cview.contains(a)) return null;
  if (a.id) return { sel: '#' + CSS.escape(a.id) };
  const self = a.dataset.cv ? `[data-cv="${a.dataset.cv}"]` : a.dataset.cvShow ? `[data-cv-show="${a.dataset.cvShow}"]` : a.dataset.cvMode ? `[data-cv-mode="${a.dataset.cvMode}"]` : '';
  const row = a.closest('[data-cv-id]'), item = a.closest('[data-cv-item]');
  if (row) {
    const r = `#cv-list [data-cv-id="${CSS.escape(row.dataset.cvId)}"]`;
    return { sel: `${r} ${self}`, fallback: `${r} [data-cv="select"]` };
  }
  if (item) return { sel: `#cv-items [data-cv-item="${CSS.escape(item.dataset.cvItem)}"] ${self}` };
  return self ? { sel: (a.closest('#cv-head') ? '#cv-head ' : a.closest('#cv-tools') ? '#cv-tools ' : '') + self } : null;
}

function renderCustom() {
  const mode = CV.mode;
  const focus = cvFocusKey();
  const top = { list: cvList.scrollTop, items: cvItems.scrollTop, sel: CV.sel };
  const all = editEntries(mode);
  // voce aperta sparita (gruppo eliminato): nessuna; sul desktop si apre la prima
  if (CV.sel && !all.some((e) => e.category_id === CV.sel)) CV.sel = null;
  if (!CV.sel && all.length && !isMobile()) CV.sel = all[0].category_id;
  document.querySelectorAll('[data-cv-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.cvMode === mode)));
  document.querySelectorAll('[data-cv-show]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cvShow === CV.show)));
  const sync = typeof SY !== 'undefined' && SY.keys ? 'le modifiche arrivano su tutti i dispositivi sincronizzati' : 'con la sincronizzazione attiva le modifiche arrivano su tutti i dispositivi';
  $('cv-sub').textContent = `${S.acctName || (S.creds && S.creds.username) || ''} · ${sync}`;
  renderCvSide(all);
  renderCvPane(all);
  cvList.scrollTop = top.list;
  if (top.sel === CV.sel) cvItems.scrollTop = top.items;
  if (focus) {
    const el = cview.querySelector(focus.sel + ':not(:disabled)') || (focus.fallback && cview.querySelector(focus.fallback));
    if (el) { el.focus({ preventScroll: true }); el.scrollIntoView({ block: 'nearest' }); }
  }
}

function renderCvSide(all) {
  const mode = CV.mode;
  if (!S.rawCategories[mode]) {
    cvList.innerHTML = B.errors[mode] ? cvEmpty(`Categorie non disponibili: ${escapeHtml(B.errors[mode])}`) : cvLoading('Caricamento categorie…');
    $('cv-bulk').classList.add('hidden');
    $('cv-stats').textContent = '';
    return;
  }
  const list = listedEntries(all);
  const counts = catCounts(mode);
  // si riordina solo l'elenco completo
  const ordering = list.length === all.length;
  const drag = ordering && canDrag();
  cvList.innerHTML = list.map((e, i) => {
    const name = escapeHtml(e.category_name);
    const renamed = !e.group && e.category_name !== e.original;
    const n = entryCount(mode, e, counts);
    const sel = e.category_id === CV.sel;
    return `<div class="cv-row${sel ? ' is-sel' : ''}${e.hidden ? ' is-hidden' : ''}" data-cv-id="${escapeHtml(e.category_id)}"${drag ? ' draggable="true"' : ''}>
      ${drag ? `<span class="cv-grip" title="Trascina per spostare">${CE_ICONS.grip}</span>` : ''}
      <button type="button" class="cv-name" data-cv="select" aria-current="${sel}">
        <span class="cv-label">${e.group ? `<span class="text-info shrink-0">${CE_ICONS.folder}</span>` : ''}<span class="truncate">${name}</span></span>
        ${renamed ? `<small class="truncate">${escapeHtml(e.original)}</small>` : ''}
      </button>
      <span class="cv-count">${n != null ? n.toLocaleString('it-IT') : ''}</span>
      ${ibtn('hide', e.hidden ? `Mostra ${name}` : `Nascondi ${name}`, eyeSvg(e.hidden))}
      ${ordering ? ibtn('up', 'Sposta su', CE_ICONS.up, i === 0) + ibtn('down', 'Sposta giù', CE_ICONS.down, i === list.length - 1) : ''}
    </div>`;
  }).join('') || cvEmpty(!all.length ? 'Nessuna categoria in questa sezione.'
    : CV.show === 'hidden' && !cvSearch.value.trim() ? 'Nessuna categoria nascosta.'
    : CV.show === 'groups' && !cvSearch.value.trim() ? 'Nessun gruppo: creane uno con “+ Gruppo”.' : 'Nessuna categoria trovata.');
  // ricerca o filtro: azioni su tutte le voci trovate
  const bulk = $('cv-bulk');
  bulk.classList.toggle('hidden', ordering || !list.length);
  if (!ordering && list.length) {
    const hid = list.filter((e) => e.hidden).length;
    bulk.innerHTML = `<span class="flex-1 min-w-0 truncate text-ink-subtle">${list.length} trovat${list.length === 1 ? 'a' : 'e'} · riordina senza filtri</span>
      <button type="button" class="btn btn-secondary btn-sm" data-cv="bulk-hide"${hid === list.length ? ' disabled' : ''}>Nascondi tutte</button>
      <button type="button" class="btn btn-secondary btn-sm" data-cv="bulk-show"${!hid ? ' disabled' : ''}>Mostra tutte</button>`;
  }
  const cats = all.filter((e) => !e.group), hidden = all.filter((e) => e.hidden).length, groups = all.length - cats.length;
  $('cv-stats').textContent = `${cats.length} categorie · ${hidden} nascost${hidden === 1 ? 'a' : 'e'} · ${groups} grupp${groups === 1 ? 'o' : 'i'}`;
}

function cvItemHtml(mode, it, opts) {
  const id = String(it.stream_id);
  CV.shown.set(id, it);
  const icon = okUrl(it.stream_icon)
    ? `<img src="${escapeHtml(it.stream_icon)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="w-full h-full object-contain" alt="">`
    : `<span>${escapeHtml(initials(it.name))}</span>`;
  const cat = S.catNames[mode].get(String(it.category_id)) || '';
  let actions = '';
  if (opts.toggle) {
    const on = inGroup(mode, opts.toggle, it);
    actions += `<button type="button" class="btn btn-sm ${on ? 'btn-ghost text-info' : 'btn-secondary'} shrink-0" data-cv="toggle" aria-pressed="${on}">${on ? `${ICONS.check} Nel gruppo` : '+ Aggiungi'}</button>`;
  }
  if (opts.reorder) {
    actions += ibtn('iup', 'Sposta su', CE_ICONS.up, opts.i === 0) + ibtn('idown', 'Sposta giù', CE_ICONS.down, opts.i === opts.n - 1) +
      ibtn('remove', `Togli ${escapeHtml(it.name)} dal gruppo`, CE_ICONS.x);
  }
  const drag = opts.reorder && canDrag();
  return `<div class="cv-item" data-cv-item="${escapeHtml(id)}"${drag ? ' draggable="true"' : ''}>
    ${drag ? `<span class="cv-grip" title="Trascina per spostare">${CE_ICONS.grip}</span>` : ''}
    <span class="logo-tile w-10 h-10 rounded-lg shrink-0 overflow-hidden flex items-center justify-center text-[11px] font-extrabold text-ink-muted">${icon}</span>
    <span class="flex-1 min-w-0"><span class="block truncate text-sm font-semibold text-ink">${escapeHtml(it.name)}</span>
      ${opts.showCat && cat ? `<span class="block truncate text-[11px] font-medium text-ink-subtle">${escapeHtml(cat)}</span>` : ''}</span>
    ${actions}
  </div>`;
}

function renderCvPane(all) {
  const mode = CV.mode, unit = MODE_API[mode].unit;
  const e = CV.sel && all.find((x) => x.category_id === CV.sel);
  CV.shown = new Map();
  const tools = $('cv-tools');
  if (!e) {
    $('cv-head').innerHTML = `<button type="button" class="cv-back btn btn-ghost btn-sm mb-2" data-cv="back">${ICONS.back} Categorie</button>
      <h2 class="text-xl font-extrabold">Scegli una categoria o un gruppo</h2>
      <p class="mt-1 text-sm text-ink-muted max-w-xl">Nascondi le categorie che non usi, rinominale e mettile nell'ordine che preferisci. Con i gruppi raccogli ${unit} di categorie diverse.</p>`;
    tools.classList.add('hidden');
    cvItems.innerHTML = '';
    return;
  }
  const counts = catCounts(mode);
  const n = entryCount(mode, e, counts);
  const renamed = !e.group && e.category_name !== e.original;
  const pos = all.indexOf(e);
  const meta = [renamed ? `Nome del provider: ${escapeHtml(e.original)}` : '', n != null ? `${n.toLocaleString('it-IT')} ${unit}` : ''].filter(Boolean).join(' · ');
  $('cv-head').innerHTML = `<button type="button" class="cv-back btn btn-ghost btn-sm mb-2" data-cv="back">${ICONS.back} Categorie</button>
    <p class="overline">${e.group ? 'Gruppo personale' : 'Categoria del provider'}</p>
    <h2 class="text-2xl font-extrabold tracking-tight truncate${e.hidden ? ' text-ink-subtle line-through' : ''}">${escapeHtml(e.category_name)}</h2>
    ${meta ? `<p class="text-xs text-ink-subtle mt-0.5">${meta}</p>` : ''}
    ${e.hidden ? `<p class="mt-2 inline-block text-xs font-medium text-accent-ink bg-accent-soft rounded-md px-2 py-1">Nascost${e.group ? 'o' : 'a'}: non compare in liste, righe e ricerca.</p>` : ''}
    <div class="flex flex-wrap gap-2 mt-3">
      <button type="button" class="btn btn-secondary btn-sm" data-cv="hide">${eyeSvg(!e.hidden).replace('<svg', '<svg class="w-4 h-4"')}${e.hidden ? 'Mostra' : 'Nascondi'}</button>
      <button type="button" class="btn btn-secondary btn-sm" data-cv="rename">Rinomina</button>
      ${renamed ? '<button type="button" class="btn btn-ghost btn-sm" data-cv="orig">Nome originale</button>' : ''}
      <button type="button" class="btn btn-ghost btn-sm" data-cv="top"${pos === 0 ? ' disabled' : ''}>In cima</button>
      <button type="button" class="btn btn-ghost btn-sm" data-cv="bottom"${pos === all.length - 1 ? ' disabled' : ''}>In fondo</button>
      ${e.group ? '<button type="button" class="btn btn-ghost btn-sm text-danger" data-cv="delete">Elimina gruppo</button>' : ''}
    </div>`;
  tools.classList.remove('hidden');
  const groups = S.custom[mode].groups;
  const cat = rawCatalog(mode);
  const q = cvQ.value.trim();
  let html = '';
  if (e.group) {
    cvQ.placeholder = `Cerca ${unit} da aggiungere al gruppo…`;
    $('cv-target').innerHTML = '';
    if (q) {
      if (!cat) html += B.errors[mode] ? cvEmpty('Catalogo non disponibile.') : cvLoading('Caricamento del catalogo…');
      else {
        const r = XPCore.searchItems(cat, q, ADD_MAX);
        html += `<p class="cv-sec">Risultati${r.total > r.items.length ? ` (primi ${r.items.length} di ${r.total.toLocaleString('it-IT')})` : ''}</p>`;
        html += r.items.map((it) => cvItemHtml(mode, it, { toggle: e.category_id, showCat: true })).join('') || cvEmpty(`Nessun risultato per “${escapeHtml(q)}”.`);
      }
    }
    const list = groupItems(mode, e.category_id);
    html += `<p class="cv-sec">Nel gruppo · ${list.length}</p>`;
    html += list.map((it, i) => cvItemHtml(mode, it, { reorder: true, i, n: list.length, showCat: true })).join('')
      || cvEmpty(`Il gruppo è vuoto: cerca qui sopra i ${unit} da aggiungere, oppure apri una categoria e aggiungili da lì.`);
  } else {
    cvQ.placeholder = 'Cerca in questa categoria…';
    if (!groups.some((g) => g.id === CV.target)) CV.target = groups.length ? groups[0].id : null;
    $('cv-target').innerHTML = groups.length
      ? `<label class="flex items-center gap-2 text-xs font-semibold text-ink-muted">Aggiungi a
          <select id="cv-target-sel" class="field field-sm !w-auto !h-9 max-w-[14rem]">${groups.map((g) => `<option value="${escapeHtml(g.id)}"${g.id === CV.target ? ' selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}</select></label>
         <button type="button" class="btn btn-ghost btn-sm" data-cv="new-target">+ Gruppo</button>`
      : `<button type="button" class="btn btn-secondary btn-sm" data-cv="new-target">${CE_ICONS.folderPlus} Crea un gruppo per raccogliere ${unit}</button>`;
    if (!cat) html += B.errors[mode] ? cvEmpty('Catalogo non disponibile.') : cvLoading('Caricamento del catalogo…');
    else {
      const terms = normKey(q).split(/\s+/).filter(Boolean);
      const items = cat.filter((it) => String(it.category_id) === e.category_id
        && (!terms.length || terms.every((t) => (it._k != null ? it._k : normKey(it.name)).includes(t))));
      html += items.slice(0, ITEMS_MAX).map((it) => cvItemHtml(mode, it, { toggle: CV.target })).join('')
        || cvEmpty(q ? `Nessun risultato per “${escapeHtml(q)}”.` : `Nessun elemento in questa categoria.`);
      if (items.length > ITEMS_MAX) html += cvEmpty(`Mostrati i primi ${ITEMS_MAX} di ${items.length.toLocaleString('it-IT')}: cerca per trovare gli altri.`);
    }
  }
  cvItems.innerHTML = html;
}

// ------------------------------------------------------------------ eventi della pagina
async function onCustomClick(ev) {
  const tab = ev.target.closest('[data-cv-mode]');
  if (tab) { if (tab.dataset.cvMode !== CV.mode) { cview.classList.remove('cv-pane-open'); showCustomMode(tab.dataset.cvMode, null); } return; }
  const sh = ev.target.closest('[data-cv-show]');
  if (sh) { CV.show = sh.dataset.cvShow; renderCustom(); return; }
  const b = ev.target.closest('[data-cv]');
  if (!b || b.disabled) return;
  const act = b.dataset.cv, mode = CV.mode;
  const row = b.closest('[data-cv-id]'), itemEl = b.closest('[data-cv-item]');
  const id = row ? row.dataset.cvId : CV.sel;
  const item = itemEl && CV.shown.get(itemEl.dataset.cvItem);
  let changed = false;
  switch (act) {
    case 'close': closeCustom(); return;
    case 'back': closeCustomPane(); return;
    case 'select':
      if (CV.sel !== id) { CV.sel = id; cvQ.value = ''; }
      cview.classList.add('cv-pane-open');
      renderCustom();
      if (isMobile()) { const f = $('cv-head').querySelector('[data-cv="hide"]'); if (f) f.focus({ preventScroll: true }); }
      return;
    case 'new': {
      const gid = await createGroup(mode);
      if (!gid) return;
      CV.sel = gid; CV.show = CV.show === 'hidden' ? 'all' : CV.show;
      cview.classList.add('cv-pane-open');
      changed = true;
      break;
    }
    case 'new-target': {
      const gid = await createGroup(mode);
      if (!gid) return;
      CV.target = gid;
      changed = true;
      break;
    }
    case 'reset': changed = await resetCustom(mode); break;
    case 'bulk-hide': case 'bulk-show': {
      const ids = listedEntries(editEntries(mode)).map((e) => e.category_id);
      const c = S.custom[mode];
      const hidden = act === 'bulk-hide' ? c.hidden.concat(ids) : c.hidden.filter((x) => !ids.includes(x));
      saveCustom(mode, { ...c, hidden });
      toast(act === 'bulk-hide' ? `${ids.length} nascost${ids.length === 1 ? 'a' : 'e'}` : `${ids.length} di nuovo visibil${ids.length === 1 ? 'e' : 'i'}`, 'ok');
      changed = true;
      break;
    }
    case 'toggle': {
      const gid = isGroupId(CV.sel) ? CV.sel : CV.target;
      if (item && gid) changed = toggleGroupItem(mode, gid, item, !inGroup(mode, gid, item));
      break;
    }
    case 'remove':
      if (item) changed = toggleGroupItem(mode, CV.sel, item, false);
      break;
    case 'iup': case 'idown': {
      const list = groupItems(mode, CV.sel);
      if (!item) break;
      const order = XPCore.moveId(list.map((x) => String(x.stream_id)), item.stream_id, act === 'iup' ? -1 : 1);
      saveGroup(mode, CV.sel, reorderItems(list, order));
      changed = true;
      break;
    }
    default:
      if (!id) return;
      changed = await customAction(mode, act, id);
  }
  if (changed) onCustomChanged(mode);
}
cview.addEventListener('click', onCustomClick);
const reorderItems = (list, order) => {
  const by = new Map(list.map((x) => [String(x.stream_id), x]));
  return order.map((k) => by.get(k)).filter(Boolean);
};
cvSearch.addEventListener('input', debounce(() => renderCustom(), 80));
cvQ.addEventListener('input', debounce(() => renderCustom(), 120));
cview.addEventListener('change', (ev) => {
  if (ev.target.id === 'cv-target-sel') { CV.target = ev.target.value; renderCustom(); }
});
cvItems.addEventListener('error', (ev) => {
  const t = ev.target;
  if (t && t.tagName === 'IMG' && t.parentElement) t.replaceWith(Object.assign(document.createElement('span'), { textContent: '·' }));
}, true);

// trascinamento: categorie nell'elenco, elementi nel gruppo aperto
const dragKind = (el) => (el.dataset.cvId != null ? 'cat' : 'item');
function dropRow(ev) {
  const r = ev.target.closest && ev.target.closest('[draggable="true"]');
  return r && CV.drag && dragKind(r) === CV.drag.kind ? r : null;
}
function clearDrop() { cview.querySelectorAll('.drop-before, .drop-after, .is-drag').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'is-drag')); }
cview.addEventListener('dragstart', (ev) => {
  const r = ev.target.closest && ev.target.closest('[draggable="true"]');
  if (!r) return;
  CV.drag = { kind: dragKind(r), id: r.dataset.cvId != null ? r.dataset.cvId : r.dataset.cvItem };
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', CV.drag.id);
  r.classList.add('is-drag');
});
cview.addEventListener('dragover', (ev) => {
  const r = dropRow(ev);
  if (!r) return;
  ev.preventDefault();
  const b = r.getBoundingClientRect(), after = ev.clientY > b.top + b.height / 2;
  cview.querySelectorAll('.drop-before, .drop-after').forEach((x) => { if (x !== r) x.classList.remove('drop-before', 'drop-after'); });
  r.classList.toggle('drop-after', after);
  r.classList.toggle('drop-before', !after);
});
cview.addEventListener('dragend', () => { CV.drag = null; clearDrop(); });
cview.addEventListener('drop', (ev) => {
  const r = dropRow(ev), d = CV.drag, mode = CV.mode;
  if (!r || !d) return;
  ev.preventDefault();
  const after = r.classList.contains('drop-after');
  const target = d.kind === 'cat' ? r.dataset.cvId : r.dataset.cvItem;
  CV.drag = null;
  clearDrop();
  if (d.kind === 'cat') {
    const c = S.custom[mode];
    saveCustom(mode, { ...c, order: XPCore.moveIdTo(editEntries(mode).map((x) => x.category_id), d.id, target, after) });
  } else {
    const list = groupItems(mode, CV.sel);
    saveGroup(mode, CV.sel, reorderItems(list, XPCore.moveIdTo(list.map((x) => String(x.stream_id)), d.id, target, after)));
  }
  onCustomChanged(mode);
});

// scorciatoie che aprono la pagina
$('cat-edit').addEventListener('click', () => openCustom('live', S.selectedCat.live));
$('catpick-edit').addEventListener('click', () => openCustom(CP.mode, CP.sel.length === 1 ? CP.sel[0] : null));
$('acct-custom').addEventListener('click', () => openCustom(MODES.includes(S.view) ? S.view : 'live'));

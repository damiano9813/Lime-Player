// Android e Android TV: tasto Indietro, telecomando (frecce, OK, tasti media) e schermo intero.
// Sul desktop questo file non fa nulla: PLATFORM.android è falso.
'use strict';

// ------------------------------------------------------------------ tasto Indietro
// Risale un livello alla volta come Esc; al primo livello l'app va in secondo piano.
function onBackButton() {
  const active = document.activeElement;
  const typing = active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
  if ($('app-view').classList.contains('hidden')) {
    if (modalOpen()) { closeModal(false); return; }
    if (typing) { active.blur(); return; }
    // form della nuova playlist aperto sopra l'elenco: si torna all'elenco
    if (formOpen && accounts.length) { $('login-form-close').click(); return; }
    invoke('leave_app').catch(() => {});
    return;
  }
  if (modalOpen()) { closeModal(false); return; }
  if (settingsPanelOpen()) { closeSettings(); return; }
  if (customOpen()) {
    if (typing && !active.value) { active.blur(); return; }
    customBack();
    return;
  }
  if (acctMenuOpen()) { closeAcctMenu(); $('acct-btn').focus(); return; }
  if (catpickOpen()) { closeCatPick(true); return; }
  if (typing) {
    if (active.value && (active.id === 'gsearch-input' || active.id === 'stream-search' || active.id === 'cat-search')) {
      active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } else active.blur();
    return;
  }
  if (tracksMenuOpen()) { closeTracksMenu(); return; }
  if (fsElement()) {
    exitFullscreen();
    // TV: si torna sul canale in onda nella lista, già evidenziato (al frame dopo, quando la
    // pagina sotto il player è di nuovo visibile: 06b-mpv.js)
    if (PLATFORM.tv && S.currentMode === 'live' && S.mode === 'live') {
      requestAnimationFrame(() => {
        if (fsElement()) return;
        locateCurrent(false);
        renderList(false);
        const playing = rowsLayer.querySelector('.row-active');
        if (playing) playing.focus({ preventScroll: true });
      });
    }
    return;
  }
  if (playerFull()) {
    // controlli in primo piano: prima si nascondono, poi si chiude il player
    if (wrap.contains(active) && active !== wrap) { active.blur(); wrap.classList.add('idle'); return; }
    closePlayer();
    return;
  }
  if (detailOpen()) { closeDetail(); return; }
  if (browseVisible() && B.search) { clearGlobalSearch(true); return; }
  if (browseVisible() && B.grid) { closeGrid(); return; }
  if (guideOpen()) { closeGuide(); return; }
  if (theaterOn()) { setTheater(false); return; }
  if (S.view !== 'home') { setView('home'); return; }
  invoke('leave_app').catch(() => {});
}

// ------------------------------------------------------------------ navigazione spaziale
// Il telecomando ha solo frecce e OK: lo stato attivo si sposta sull'elemento più vicino nella
// direzione della freccia, tra quelli visibili nell'area in primo piano (finestra, menu, scheda).
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled):not([type=hidden]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function navScope() {
  if (modalOpen()) return $('modal');
  if (settingsPanelOpen()) return $('settings-panel');
  if (customOpen()) return $('custom-view');
  if (acctMenuOpen()) return $('acct-menu');
  if (catpickOpen()) return $('catpick');
  if ($('app-view').classList.contains('hidden')) return $('login-view');
  if (tracksMenuOpen()) return $('tracks-menu');
  if (fsElement() || playerFull()) return wrap;
  if (detailOpen()) return $('detail-view');
  return $('app-view');
}

function visibleRect(el) {
  if (!el.getClientRects().length) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const st = getComputedStyle(el);
  if (st.visibility === 'hidden' || Number(st.opacity) === 0) return null;
  // controlli del player nascosti per inattività: restano raggiungibili, il focus li rimostra
  if (st.pointerEvents === 'none' && !el.closest('#player-wrap.idle #controls')) return null;
  return r;
}

// contenitori con tabindex (scorrimento da tastiera sul desktop): col telecomando si va sulle righe
const NAV_CONTAINERS = '#browse-scroller, #list-scroller, #guide-scroller';

// Elementi raggiungibili. Prima la posizione (economica), poi gli stili solo per quelli entro una
// schermata da quella visibile: con centinaia di categorie o locandine ogni freccia resta veloce, e
// i più lontani non sarebbero comunque i più vicini.
// Elenchi lunghi (centinaia di righe di locandine o di categorie): si guardano solo i figli vicini
// allo schermo, trovati con una ricerca binaria sulla posizione (i figli sono in colonna).
const LONG_LISTS = ['#browse-page .rows', '#cat-list', '#cv-list', '#catpick-list', '#list-rows', '#guide-rows', '#catchup-list'];
const OUTSIDE_LONG = FOCUSABLE.split(', ').map((s) => s + LONG_LISTS.map((l) => `:not(${l} *)`).join('')).join(', ');
function nearChildren(box, h) {
  const kids = box.children, n = kids.length;
  if (n < 40) return Array.from(kids);
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (kids[m].getBoundingClientRect().bottom < -h) lo = m + 1; else hi = m; }
  const out = [];
  for (let i = lo; i < n; i++) {
    if (kids[i].getBoundingClientRect().top > 2 * h) break;
    out.push(kids[i]);
  }
  return out;
}
function focusables(scope, h) {
  const out = Array.from(scope.querySelectorAll(OUTSIDE_LONG));
  for (const sel of LONG_LISTS) {
    const box = scope.querySelector(sel);
    if (!box || !box.getClientRects().length) continue;
    for (const kid of nearChildren(box, h)) {
      if (kid.matches(FOCUSABLE)) out.push(kid);
      out.push(...kid.querySelectorAll(FOCUSABLE));
    }
  }
  return out;
}

function candidates(scope) {
  const out = [];
  const w = innerWidth, h = innerHeight;
  for (const el of focusables(scope, h)) {
    // tabindex="-1": solo per mouse e tocco
    if (el.tabIndex < 0 || el.matches(NAV_CONTAINERS)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < -h || r.top > 2 * h || r.right < -w || r.left > 2 * w) continue;
    // fuori dalla scheda o sotto il player a tutta finestra: non raggiungibili
    if (el.closest('.hidden, [inert], [aria-hidden="true"]') || !visibleRect(el)) continue;
    out.push({ el, r });
  }
  return out;
}

// Contenitori che scorrono in verticale: la freccia resta dentro quello dell'elemento attivo
// finché trova qualcosa (anche fuori schermo, che poi scorre in vista), poi passa al resto.
const SCROLLERS = '#browse-scroller, #list-scroller, #guide-scroller, #detail-view, #cv-list, #cv-items, #cat-list, #catpick-list, .overflow-y-auto';
const scrollerOf = (el) => el.closest(SCROLLERS);
const clipRect = (a, r) => ({ top: Math.max(a.top, r.top), left: Math.max(a.left, r.left), bottom: Math.min(a.bottom, r.bottom), right: Math.min(a.right, r.right) });
// parte davvero visibile per un elemento: finestra, contenitore (nelle pagine a righe sotto la
// barra in alto, che le copre) e riga di locandine che scorre in orizzontale
function visibleArea(el, cache) {
  const sc = scrollerOf(el) || document.body;
  let area = cache.get(sc);
  if (!area) {
    area = { top: 0, left: 0, bottom: innerHeight, right: innerWidth };
    if (sc !== document.body) area = clipRect(area, sc.getBoundingClientRect());
    if (sc.id === 'browse-scroller') area.top = Math.max(area.top, $('topbar').getBoundingClientRect().bottom);
    cache.set(sc, area);
  }
  const track = el.closest('.row-track');
  if (!track) return area;
  let t = cache.get(track);
  if (!t) { t = clipRect(area, track.getBoundingClientRect()); cache.set(track, t); }
  return t;
}
function isVisible(r, a) {
  const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
  return x >= a.left && x <= a.right && y >= a.top && y <= a.bottom;
}
const overlapsV = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;

// distanza nella direzione (prima componente) e scarto laterale (seconda, pesata di più)
function score(from, to, dir) {
  const fx = (from.left + from.right) / 2, fy = (from.top + from.bottom) / 2;
  const tx = (to.left + to.right) / 2, ty = (to.top + to.bottom) / 2;
  const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
  let main, side;
  switch (dir) {
    case 'down':
      if (ty <= fy + 1 || to.top < from.top + 4) return Infinity;
      main = Math.max(0, to.top - from.bottom);
      side = overlap(from.left, from.right, to.left, to.right) > 0 ? 0 : Math.abs(tx - fx);
      break;
    case 'up':
      if (ty >= fy - 1 || to.bottom > from.bottom - 4) return Infinity;
      main = Math.max(0, from.top - to.bottom);
      side = overlap(from.left, from.right, to.left, to.right) > 0 ? 0 : Math.abs(tx - fx);
      break;
    case 'right':
      if (tx <= fx + 1 || to.left < from.left + 4) return Infinity;
      main = Math.max(0, to.left - from.right);
      side = overlap(from.top, from.bottom, to.top, to.bottom) > 0 ? 0 : Math.abs(ty - fy);
      break;
    default:
      if (tx >= fx - 1 || to.right > from.right - 4) return Infinity;
      main = Math.max(0, from.left - to.right);
      side = overlap(from.top, from.bottom, to.top, to.bottom) > 0 ? 0 : Math.abs(ty - fy);
  }
  return main + side * 3;
}

// lo scorrimento rispetta scroll-padding (index.html): niente elementi sotto la barra in alto
function focusEl(el) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// quando lo stato attivo non c'è, è sparito o è su un contenitore (scheda, pagina a righe): il
// primo elemento visibile tra quelli principali della pagina, poi un pulsante primario, poi il
// primo in alto a sinistra fuori dalla barra in alto
function focusFirst(scope) {
  const list = candidates(scope);
  if (!list.length) return false;
  const cache = new Map();
  const vis = list.filter((c) => isVisible(c.r, visibleArea(c.el, cache)));
  const starts = scope.id !== 'app-view' ? []
    : browseVisible() ? ['#browse-page .btn-play', '#browse-page .pcard-btn'] : guideOpen() ? ['#guide-rows [data-gch]']
    : ['#list-rows .row-active', '#list-rows .vrow'];
  for (const sel of starts.concat('.btn-primary, [data-primary]')) {
    const c = vis.find((x) => x.el.matches(sel));
    if (c) { focusEl(c.el); return true; }
  }
  const pool = vis.filter((c) => !c.el.closest('#topbar'));
  const sorted = (pool.length ? pool : vis.length ? vis : list).sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));
  focusEl(sorted[0].el);
  return true;
}
// contenitore (pagina, scheda, lista): lo stato attivo va su un elemento al suo interno. I
// pulsanti con tabindex="-1" raggiunti apposta (es. "Vedi tutti" del titolo) non lo sono.
const isContainer = (el, scope) => el === scope || el.matches(NAV_CONTAINERS) || (el.tabIndex < 0 && !el.matches('button, a[href]'));

// L'elemento più vicino nella direzione, in quest'ordine: visibile nello stesso contenitore,
// fuori schermo nello stesso contenitore (si scorre), visibile altrove. ←/→ restano sulla stessa
// riga; nella barra in alto ←/→ non escono dalla barra.
function moveFocus(dir) {
  const scope = navScope();
  const cur = document.activeElement;
  if (!cur || cur === document.body || !scope.contains(cur) || !visibleRect(cur) || isContainer(cur, scope)) return focusFirst(scope);
  const from = cur.getBoundingClientRect();
  const horiz = dir === 'left' || dir === 'right';
  const inTopbar = !!cur.closest('#topbar');
  const mySc = scrollerOf(cur);
  const cache = new Map();
  const list = [];
  for (const c of candidates(scope)) {
    if (c.el === cur || c.el.contains(cur)) continue;
    if (horiz && inTopbar && !c.el.closest('#topbar')) continue;
    c.s = score(from, c.r, dir);
    if (c.s === Infinity) continue;
    c.row = !horiz || overlapsV(from, c.r);
    c.sc = scrollerOf(c.el);
    c.vis = isVisible(c.r, visibleArea(c.el, cache));
    list.push(c);
  }
  const pick = (ok) => {
    let best = null;
    for (const c of list) if (ok(c) && (!best || c.s < best.s)) best = c;
    return best;
  };
  const best = (mySc && (pick((c) => c.row && c.sc === mySc && c.vis) || pick((c) => c.row && c.sc === mySc)))
    || pick((c) => c.row && c.vis) || pick((c) => c.row && !c.sc && !mySc)
    // ←/→ senza nulla sulla stessa riga: il più vicino tra quelli visibili, ma non nelle pagine a
    // righe (si salterebbe su un'altra riga) né verso la barra in alto
    || (horiz && !inTopbar && !cur.closest('#browse-scroller') ? pick((c) => c.vis && !c.el.closest('#topbar')) : null);
  if (!best) return false;
  focusEl(best.el);
  return true;
}

// lista virtualizzata dei canali: le righe fuori schermo non esistono, si scorre e poi si sposta
function moveInList(row, delta) {
  const idx = +row.dataset.idx + delta;
  if (idx < 0 || idx >= S.filtered.length) return false;
  scrollToIndex(idx);
  renderList(false);
  const next = rowsLayer.querySelector(`[data-idx="${idx}"]`);
  if (!next) return false;
  next.focus({ preventScroll: true });
  return true;
}

// Guida TV: con centinaia di programmi a schermo la ricerca generale li misurerebbe tutti a ogni
// freccia. Si va per struttura: ←/→ al programma accanto nella riga (← dal primo: il canale, ← dal
// canale: la categoria scelta), ↑/↓ alla riga sopra o sotto, sul programma alla stessa ora o, se la
// riga non ha guida, sul canale. Sulla TV ogni programma si raggiunge (09-guide.js).
function moveInGuide(el, dir) {
  const isCh = el.dataset.gch != null;
  const row = isCh ? el.parentElement : el.parentElement && el.parentElement.parentElement;
  if (!row) return false;
  if (dir === 'left' || dir === 'right') {
    if (isCh) {
      if (dir === 'left') {
        const cat = $('cat-list').querySelector('[aria-current="true"]');
        if (!cat || !visibleRect(cat.parentElement)) return false;
        focusEl(cat);
        return true;
      }
      const edge = el.getBoundingClientRect().right;
      const first = Array.from(row.querySelectorAll('[data-gr]')).find((b) => b.getBoundingClientRect().right > edge + 8);
      // riga senza programmi in vista: scorrono gli orari
      if (first) revealInGuide(first); else gScroller.scrollBy(240, 0);
      return true;
    }
    let n = dir === 'right' ? el.nextElementSibling : el.previousElementSibling;
    while (n && !n.hasAttribute('data-gr')) n = dir === 'right' ? n.nextElementSibling : n.previousElementSibling;
    if (n) { revealInGuide(n); return true; }
    if (dir === 'left') { revealInGuide(row.querySelector('[data-gch]')); return true; }
    gScroller.scrollBy(240, 0);
    return true;
  }
  const j = +(isCh ? el.dataset.gch : el.dataset.gr) + (dir === 'down' ? 1 : -1);
  const ch = j >= 0 && gRows.querySelector(`[data-gch="${j}"]`);
  if (!ch) return false;
  if (isCh) { revealInGuide(ch); return true; }
  // centro della parte visibile del programma attuale (può iniziare ore prima)
  const sr = gScroller.getBoundingClientRect(), r = el.getBoundingClientRect();
  const x = Math.min(sr.right - 1, Math.max(sr.left + guideChW() + 1, (r.left + r.right) / 2));
  let best = null, bestD = Infinity;
  for (const b of ch.parentElement.querySelectorAll('[data-gr]')) {
    const br = b.getBoundingClientRect();
    const d = x < br.left ? br.left - x : x > br.right ? x - br.right : 0;
    if (d < bestD) { best = b; bestD = d; }
    if (!d) break;
  }
  revealInGuide(best && bestD < 240 ? best : ch);
  return true;
}
// in vista sotto la riga degli orari e accanto alla colonna dei canali (entrambe fisse): un
// programma che ci sta si mostra per intero, uno più lungo della vista almeno in parte
function revealInGuide(el) {
  el.focus({ preventScroll: true });
  const sr = gScroller.getBoundingClientRect(), r = el.getBoundingClientRect();
  const top = sr.top + GUIDE_HEAD_H;
  const dy = r.top < top ? r.top - top : r.bottom > sr.bottom ? r.bottom - sr.bottom : 0;
  let dx = 0;
  if (el.dataset.gr != null) {
    const left = sr.left + guideChW();
    if (r.width <= sr.right - left) dx = r.left < left ? r.left - left : r.right > sr.right ? r.right - sr.right : 0;
    else if (Math.min(r.right, sr.right) - Math.max(r.left, left) < 80) dx = r.left < left ? r.right - left - 80 : r.left - sr.right + 80;
  }
  if (dx || dy) gScroller.scrollBy(dx, dy);
}

function moveInColumn(el, down) {
  let n = down ? el.nextElementSibling : el.previousElementSibling;
  while (n && !(n.matches('button:not(:disabled)') && n.getClientRects().length)) n = down ? n.nextElementSibling : n.previousElementSibling;
  if (!n) return false;
  focusEl(n);
  return true;
}

// ------------------------------------------------------------------ tasti del telecomando
const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
// guardando un contenuto (schermo intero, cinema, player a tutta finestra) le frecce restano
// quelle del desktop (canale, volume, ±10 s) finché i controlli non hanno lo stato attivo
const watching = () => !!S.current && (!!fsElement() || playerFull() || theaterOn());

// tasto tenuto premuto: gli eventi rimasti in coda più di così (il box non ha fatto in tempo a
// gestirli) si scartano, e lo spostamento si ferma quando si lascia il tasto
const STALE_REPEAT_MS = 150;

function onRemoteKey(ev) {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
  const k = ev.key;
  if (ev.repeat && (ARROWS[k] || k === 'ChannelUp' || k === 'ChannelDown') && performance.now() - ev.timeStamp > STALE_REPEAT_MS) {
    ev.preventDefault(); ev.stopImmediatePropagation();
    return;
  }
  // tasti media e canale: stessi comandi delle scorciatoie da tastiera
  const media = {
    MediaPlayPause: togglePlay, MediaPlay: () => { if (isPaused()) togglePlay(); }, MediaPause: () => { if (!isPaused()) togglePlay(); },
    MediaStop: () => { if (playerFull()) closePlayer(); else { destroyPlayer(); resetPlayerUi(); } },
    MediaFastForward: () => seekBy(30), MediaRewind: () => seekBy(-30),
    MediaTrackNext: () => stepChannel(1), MediaTrackPrevious: () => stepChannel(-1),
    ChannelUp: () => stepChannel(-1), ChannelDown: () => stepChannel(1),
    // guardando: il titolo in alto con logo, numero e programma in onda; altrimenti il nome
    Info: () => {
      if (!S.current) return;
      poke();
      if (watching()) showOsdTop(S.current, S.currentMode); else osd(escapeHtml(S.current.name || ''));
    },
    GoBack: onBackButton, BrowserBack: onBackButton,
  };
  if (media[k]) { ev.preventDefault(); ev.stopImmediatePropagation(); media[k](); return; }
  if (!PLATFORM.tv) return;

  const active = document.activeElement;
  const tag = (active && active.tagName) || '';
  const inPlayer = active && wrap.contains(active) && active !== wrap;
  // controlli spariti per inattività con lo stato ancora su un pulsante: il primo tasto li mostra
  // soltanto (niente clic o spostamenti su pulsanti invisibili)
  if (inPlayer && wrap.classList.contains('idle') && (k === 'Enter' || ARROWS[k])) {
    ev.preventDefault(); ev.stopImmediatePropagation();
    poke();
    return;
  }

  if (k === 'Enter' && active && active.matches && active.matches(TEXT_INPUT) && active.getAttribute('inputmode') === 'none') {
    ev.preventDefault(); ev.stopImmediatePropagation();
    openKeyboard(active);
    return;
  }
  if (k === 'Enter') {
    // OK guardando a schermo pieno: mostra i controlli con lo stato sul tasto play
    if (watching() && !inPlayer && !modalOpen() && !settingsPanelOpen() && (!active || active === document.body || active === wrap)) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      poke();
      focusEl($('btn-play'));
      return;
    }
    // elementi non nativi (righe, schede con tabindex): OK equivale al clic
    if (active && active !== document.body && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(tag)) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      active.click();
    }
    return;
  }

  const dir = ARROWS[k];
  if (!dir) return;
  // nei campi di testo ←/→ muovono il cursore finché non arriva al bordo
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const t = active.type;
    if (t === 'range' && (dir === 'left' || dir === 'right')) { if (inPlayer) poke(); return; }
    if ((dir === 'left' || dir === 'right') && typeof active.selectionStart === 'number' && t !== 'checkbox' && t !== 'radio') {
      const atEdge = dir === 'left' ? active.selectionStart === 0 && active.selectionEnd === 0
        : active.selectionEnd === active.value.length;
      if (!atEdge) return;
    }
  }
  // guardando senza controlli in primo piano
  if (watching() && !inPlayer && !modalOpen() && !settingsPanelOpen() && !acctMenuOpen() && !tracksMenuOpen()) {
    if (fsElement() || playerFull()) {
      // film ed episodi: ↑/↓ aprono i controlli (il volume è quello del telecomando), ←/→ ±10 s;
      // canali: ↑/↓ cambiano canale, ←/→ aprono i controlli (10-main.js fa il resto)
      const horiz = dir === 'left' || dir === 'right';
      if (S.currentMode === 'live' ? horiz : !horiz) {
        ev.preventDefault(); ev.stopImmediatePropagation();
        poke();
        focusEl($('btn-play'));
      }
      return;
    }
    // modalità cinema nella Live TV: ↑/↓ cambiano canale, ←/→ mostrano la lista
    if (dir === 'up' || dir === 'down') return;
    setTheater(false);
  }
  ev.preventDefault();
  ev.stopImmediatePropagation();
  if (inPlayer) poke();
  const row = active && active.closest && active.closest('#list-rows [data-idx]');
  if (row && (dir === 'up' || dir === 'down') && row === active && moveInList(row, dir === 'down' ? 1 : -1)) return;
  if (active && active.matches && active.matches('#guide-rows [data-gch], #guide-rows [data-gr]') && moveInGuide(active, dir)) return;
  // → dalla lista dei canali con qualcosa in riproduzione: il player accanto (tasto play), non
  // i pulsanti della scheda sotto; ← dal tasto play torna al canale in riproduzione nella lista
  const inline = !playerFull() && !fsElement();
  if (dir === 'right' && row && S.current && inline && visibleRect($('btn-play'))) { poke(); focusEl($('btn-play')); return; }
  // ← da un canale: la categoria scelta (anche lontana nella colonna), non quella alla stessa altezza
  if (dir === 'left' && row && row === active) {
    const cat = $('cat-list').querySelector('[aria-current="true"]');
    if (cat && visibleRect(cat.parentElement)) { focusEl(cat); return; }
  }
  // → da una categoria: il canale in riproduzione se è in vista, altrimenti il primo in vista
  if (dir === 'right' && active && active.parentElement === $('cat-list') && S.filtered.length && visibleRect(scroller)) {
    const sr = scroller.getBoundingClientRect();
    const playing = rowsLayer.querySelector('.row-active');
    const pr = playing && playing.getBoundingClientRect();
    const target = pr && pr.top >= sr.top && pr.bottom <= sr.bottom ? playing
      : rowsLayer.querySelector(`[data-idx="${Math.min(S.filtered.length - 1, Math.ceil(scroller.scrollTop / ROW_H))}"]`);
    if (target) { focusEl(target); return; }
  }
  if (dir === 'left' && active === $('btn-play') && inline) {
    const playing = rowsLayer.querySelector('.row-active');
    if (playing && visibleRect(playing)) { focusEl(playing); return; }
  }
  // colonna delle categorie (anche centinaia): ↑/↓ alla voce vicina senza cercare tra tutte
  if ((dir === 'up' || dir === 'down') && active && active.parentElement === $('cat-list') && moveInColumn(active, dir === 'down')) return;
  // ← sulla prima locandina di una riga: "Vedi tutti" accanto al titolo (fuori dal giro delle frecce)
  if (dir === 'left' && active && active.matches('.row-track > :first-child .pcard-btn')) {
    const all = active.closest('section').querySelector('.row-head .row-all');
    if (all) { focusEl(all); return; }
  }
  // da "Vedi tutti": ↓ e → tornano alla prima locandina della riga
  if ((dir === 'down' || dir === 'right') && active && active.matches('.row-head .row-all')) {
    const first = active.closest('section').querySelector('.row-track .pcard-btn');
    if (first) { focusEl(first); return; }
  }
  if (moveFocus(dir)) return;
  // nessun elemento in quella direzione: si scorre la pagina o si esce dai controlli del player
  if (inPlayer && (dir === 'up' || dir === 'down')) { active.blur(); wrap.classList.add('idle'); return; }
  const sc = active && active.closest && active.closest('#browse-scroller, #detail-view, #settings-panel .overflow-y-auto, #guide-scroller');
  // senza animazione: sul box quelle di più pressioni di fila si accavallano
  if (sc) sc.scrollBy({ top: dir === 'down' ? 240 : dir === 'up' ? -240 : 0, left: dir === 'right' ? 240 : dir === 'left' ? -240 : 0 });
}

// Tastiera a schermo della TV: con lo stato attivo su un campo di testo resta chiusa
// (inputmode="none"), così le frecce continuano a spostarsi; OK la apre per scrivere.
const TEXT_INPUT = 'input:not([type]), input[type=text], input[type=search], input[type=password], input[type=url], input[type=email], input[type=number], textarea';
document.addEventListener('focusin', (ev) => {
  const el = ev.target;
  if (!PLATFORM.tv || !el.matches || !el.matches(TEXT_INPUT) || el.dataset.typing) return;
  if (el.dataset.im == null) el.dataset.im = el.getAttribute('inputmode') || '';
  el.setAttribute('inputmode', 'none');
});
document.addEventListener('focusout', (ev) => {
  const el = ev.target;
  if (!el.dataset || el.dataset.im == null) return;
  if (el.dataset.im) el.setAttribute('inputmode', el.dataset.im); else el.removeAttribute('inputmode');
  delete el.dataset.im;
  delete el.dataset.typing;
});
// OK su un campo: si toglie inputmode="none" e, al frame dopo, la tastiera la apre il plugin
function openKeyboard(el) {
  el.dataset.typing = '1';
  if (el.dataset.im) el.setAttribute('inputmode', el.dataset.im); else el.removeAttribute('inputmode');
  requestAnimationFrame(() => setTimeout(() => { if (document.activeElement === el) invoke('show_keyboard').catch(() => {}); }, 30));
}

// prima delle scorciatoie di 10-main.js (stesso document, registrato prima), dopo i componenti
document.addEventListener('keydown', (ev) => { if (PLATFORM.android) onRemoteKey(ev); });
// stato attivo arrivato sui controlli del player (anche nascosti): si mostrano
wrap.addEventListener('focusin', () => { if (PLATFORM.tv) poke(); });

// ------------------------------------------------------------------ orientamento
// TV e telefono in orizzontale: l'interfaccia del desktop, larga 1280/1100 px CSS e scalata dalla
// WebView (NativePlugin.kt usa il viewport largo). Telefono in verticale: pagina larga quanto lo
// schermo con il layout "mobile" (stili html.mobile in index.html).
const isPortrait = () => {
  const t = screen.orientation && screen.orientation.type;
  return t ? t.startsWith('portrait') : window.innerHeight > window.innerWidth;
};
// schermo intero aperto dalla rotazione (non dal pulsante): si chiude tornando in verticale
let rotationFs = false;
function applyLayout() {
  const html = document.documentElement;
  const mobile = !PLATFORM.tv && isPortrait();
  const changed = html.classList.contains('mobile') !== mobile;
  html.classList.toggle('mobile', mobile);
  const vp = document.querySelector('meta[name=viewport]');
  const content = PLATFORM.tv ? 'width=1280, user-scalable=no'
    : mobile ? 'width=device-width, initial-scale=1, user-scalable=no' : 'width=1100, user-scalable=no';
  if (vp && vp.content !== content) vp.content = content;
  if (!changed || PLATFORM.tv) return;
  // telefono girato mentre si guarda: in orizzontale il video a schermo intero, come YouTube
  if (!mobile && S.current && !fsElement() && !playerFull()) { rotationFs = true; toggleFullscreen(); }
  else if (mobile && rotationFs) { rotationFs = false; if (fsElement()) exitFullscreen(); }
  // misure nuove: lista virtualizzata e rettangolo del video
  requestAnimationFrame(() => { if (S.liveReady) renderList(true); syncMpvRect(); });
  setTimeout(syncMpvRect, 300);
}

// ------------------------------------------------------------------ avvio su Android
async function initAndroid() {
  if (!PLATFORM.android) return;
  try { Object.assign(PLATFORM, await invoke('platform_info')); } catch { /* telefono */ }
  const html = document.documentElement;
  html.classList.add('android');
  html.classList.toggle('tv', !!PLATFORM.tv);
  html.classList.toggle('touch', !!PLATFORM.touch && !PLATFORM.tv);
  applyLayout();
  if (!PLATFORM.tv) {
    if (screen.orientation) screen.orientation.addEventListener('change', applyLayout);
    window.addEventListener('resize', debounce(applyLayout, 120));
  }
  // la TV parte senza nulla a fuoco: il primo tasto freccia lo assegna (moveFocus)
  if (TAURI.event) {
    TAURI.event.listen('native-key', (e) => {
      if (e.payload === 'Back') onBackButton();
      // OK su un campo di testo (la WebView non lo passa alla pagina): si apre la tastiera
      else if (e.payload === 'Select') {
        const a = document.activeElement;
        if (PLATFORM.tv && a && a.matches && a.matches(TEXT_INPUT) && a.getAttribute('inputmode') === 'none') openKeyboard(a);
      }
    }).catch(() => {});
  }
}

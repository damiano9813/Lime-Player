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
  if (acctMenuOpen()) { closeAcctMenu(); $('acct-btn').focus(); return; }
  if (catpickOpen()) { closeCatPick(true); return; }
  if (typing) {
    if (active.value && (active.id === 'gsearch-input' || active.id === 'stream-search' || active.id === 'cat-search')) {
      active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } else active.blur();
    return;
  }
  if (tracksMenuOpen()) { closeTracksMenu(); return; }
  if (fsElement()) { exitFullscreen(); return; }
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
  if (st.visibility === 'hidden' || st.pointerEvents === 'none' || Number(st.opacity) === 0) return null;
  return r;
}

function candidates(scope) {
  const out = [];
  for (const el of scope.querySelectorAll(FOCUSABLE)) {
    // fuori dalla scheda o sotto il player a tutta finestra: non raggiungibili
    if (el.closest('.hidden, [inert], [aria-hidden="true"]')) continue;
    const r = visibleRect(el);
    if (r) out.push({ el, r });
  }
  return out;
}

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

function focusEl(el) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// pulsante principale visibile (Riproduci, Accedi…), altrimenti il primo in alto a sinistra:
// quando lo stato attivo non c'è, è sparito o è su un contenitore (scheda, pagina a righe)
function focusFirst(scope) {
  const list = candidates(scope);
  if (!list.length) return false;
  const vh = window.innerHeight;
  const inView = (c) => c.r.top >= 0 && c.r.bottom <= vh;
  // pagina principale: il canale in onda (o il primo) nella Live TV, la prima locandina nelle righe
  const start = scope.id !== 'app-view' ? null
    : browseVisible() ? '#browse-page .pcard-btn' : guideOpen() ? '#guide-rows [data-gch]' : '#list-rows .row-active, #list-rows .vrow';
  const first = start && (list.find((c) => inView(c) && c.el.matches(start.split(',')[0])) || list.find((c) => inView(c) && c.el.matches(start)));
  if (first) { focusEl(first.el); return true; }
  const primary = list.find((c) => inView(c) && c.el.matches('.btn-primary, [data-primary]'));
  if (primary) { focusEl(primary.el); return true; }
  list.sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));
  focusEl((list.find(inView) || list[0]).el);
  return true;
}
const isContainer = (el, scope) => el === scope || el.tabIndex < 0 || el.matches('#browse-scroller, #list-scroller, #guide-scroller');

function moveFocus(dir) {
  const scope = navScope();
  const cur = document.activeElement;
  if (!cur || cur === document.body || !scope.contains(cur) || !visibleRect(cur) || isContainer(cur, scope)) return focusFirst(scope);
  const from = cur.getBoundingClientRect();
  let best = null, bestScore = Infinity;
  for (const c of candidates(scope)) {
    if (c.el === cur || c.el.contains(cur)) continue;
    const s = score(from, c.r, dir);
    if (s < bestScore) { bestScore = s; best = c.el; }
  }
  if (!best) return false;
  focusEl(best);
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

// ------------------------------------------------------------------ tasti del telecomando
const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
// guardando un contenuto (schermo intero, cinema, player a tutta finestra) le frecce restano
// quelle del desktop (canale, volume, ±10 s) finché i controlli non hanno lo stato attivo
const watching = () => !!S.current && (!!fsElement() || playerFull() || theaterOn());

function onRemoteKey(ev) {
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
  const k = ev.key;
  // tasti media e canale: stessi comandi delle scorciatoie da tastiera
  const media = {
    MediaPlayPause: togglePlay, MediaPlay: () => { if (isPaused()) togglePlay(); }, MediaPause: () => { if (!isPaused()) togglePlay(); },
    MediaStop: () => { if (playerFull()) closePlayer(); else { destroyPlayer(); resetPlayerUi(); } },
    MediaFastForward: () => seekBy(30), MediaRewind: () => seekBy(-30),
    MediaTrackNext: () => stepChannel(1), MediaTrackPrevious: () => stepChannel(-1),
    ChannelUp: () => stepChannel(-1), ChannelDown: () => stepChannel(1),
    Info: () => { if (S.current) { poke(); osd(escapeHtml(S.current.name || '')); } },
    GoBack: onBackButton, BrowserBack: onBackButton,
  };
  if (media[k]) { ev.preventDefault(); ev.stopImmediatePropagation(); media[k](); return; }
  if (!PLATFORM.tv) return;

  const active = document.activeElement;
  const tag = (active && active.tagName) || '';
  const inPlayer = active && wrap.contains(active) && active !== wrap;

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
  // guardando senza controlli in primo piano: comandi del desktop (10-main.js)
  if (watching() && !inPlayer && !modalOpen() && !settingsPanelOpen() && !acctMenuOpen() && !tracksMenuOpen()) {
    if (fsElement() || playerFull()) return;
    // modalità cinema nella Live TV: ↑/↓ cambiano canale, ←/→ mostrano la lista
    if (dir === 'up' || dir === 'down') return;
    setTheater(false);
  }
  ev.preventDefault();
  ev.stopImmediatePropagation();
  if (inPlayer) poke();
  const row = active && active.closest && active.closest('#list-rows [data-idx]');
  if (row && (dir === 'up' || dir === 'down') && row === active && moveInList(row, dir === 'down' ? 1 : -1)) return;
  if (moveFocus(dir)) return;
  // nessun elemento in quella direzione: si scorre la pagina o si esce dai controlli del player
  if (inPlayer && dir === 'up') { active.blur(); wrap.classList.add('idle'); return; }
  const sc = active && active.closest && active.closest('#browse-scroller, #detail-view, #settings-panel .overflow-y-auto, #guide-scroller');
  if (sc) sc.scrollBy({ top: dir === 'down' ? 240 : dir === 'up' ? -240 : 0, left: dir === 'right' ? 240 : dir === 'left' ? -240 : 0, behavior: 'smooth' });
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

// Lista virtualizzata di canali, film e serie.
'use strict';

// ------------------------------------------------------------------ lista virtualizzata
const ROW_H = 60, MAX_ROWS = 100, OVERSCAN = 8;
const V = { start: -1, end: -1 };
const scroller = $('list-scroller'), spacer = $('list-spacer'), rowsLayer = $('list-rows');

const { highlight } = XPCore;

// riga attiva: il contenuto in riproduzione, oppure la serie dell'episodio in riproduzione
function isPlayingRow(it) {
  if (!S.current) return false;
  if (S.mode === 'series') return !!S.current._series && S.current._series.stream_id === it.stream_id;
  return S.currentMode === S.mode && !S.current._catchup && S.current.stream_id === it.stream_id;
}

function rowHtml(it, idx, terms) {
  const active = isPlayingRow(it);
  const fav = isFav(S.mode, it.stream_id);
  const icon = it.stream_icon && /^https?:\/\//i.test(it.stream_icon)
    ? `<img src="${escapeHtml(it.stream_icon)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="w-full h-full object-contain" alt=""><span class="hidden">${escapeHtml(initials(it.name))}</span>`
    : `<span>${escapeHtml(initials(it.name))}</span>`;
  let sub;
  let extra = '';
  if (S.mode === 'vod') {
    const resume = getResume(resumeKey(it));
    sub = [it.container_extension ? it.container_extension.toUpperCase() : '', it.rating > 0 ? '★ ' + Number(it.rating).toFixed(1) : '',
      resume > 30 ? 'riprendi da ' + fmtTime(resume) : ''].filter(Boolean).join(' · ');
  } else if (S.mode === 'series') {
    sub = [it.genre, (it.release_date || '').slice(0, 4), it.rating > 0 ? '★ ' + Number(it.rating).toFixed(1) : ''].filter(Boolean).join(' · ');
  } else {
    // programma in onda dalla guida TV (caricata solo per le righe visibili)
    const now = epgNowTitle(it.stream_id);
    const sel = S.selectedCat[S.mode];
    sub = now || (isVirtualCat(sel) || isGroupId(sel) ? (S.catNames[S.mode].get(it.category_id) || '') : '');
    if (String(it.tv_archive) === '1') extra = `<span class="shrink-0 text-ink-subtle" title="Catch-up: programmi passati disponibili">${ICONS.rewind}</span>`;
  }
  const lead = active ? `<span class="w-9 flex justify-end shrink-0">${ICONS.eq.replace('class="eq"', `class="eq${isPaused() ? ' paused' : ''}"`)}</span>`
    : `<span class="w-7 text-right text-[11px] font-semibold tabular-nums text-ink-subtle shrink-0">${escapeHtml(it.num || idx + 1)}</span>`;
  return `<div data-idx="${idx}"${PLATFORM.tv ? ' tabindex="0"' : ''} title="${escapeHtml(it.name)}" class="vrow absolute left-0 right-0 flex items-center gap-3 px-3 rounded-lg cursor-pointer transition-colors hover:bg-s2 ${active ? 'row-active' : ''}${ZAP.timer && ZAP.item === it ? ' row-zap' : ''}" style="top:${idx * ROW_H}px;height:${ROW_H}px">
    ${lead}
    <div class="logo-tile w-10 h-10 rounded-lg shrink-0 overflow-hidden flex items-center justify-center text-[11px] font-extrabold text-ink-muted">${icon}</div>
    <div class="flex-1 min-w-0">
      <div class="text-sm truncate ${active ? 'text-accent-ink font-bold' : 'text-ink font-medium'}">${highlight(it.name, terms)}</div>
      ${sub ? `<div class="text-[11px] font-medium text-ink-subtle truncate">${escapeHtml(sub)}</div>` : ''}
    </div>
    ${extra}
    <button data-fav="${idx}" class="fav-btn p-1.5 rounded-md shrink-0 hover:bg-s3 ${fav ? 'is-fav text-accent' : 'text-ink-subtle hover:text-ink'}" title="${fav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}" aria-label="${fav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}">${fav ? ICONS.star : ICONS.starO}</button>
  </div>`;
}

// Righe disegnate: indice -> { el, html }. Si ricreano solo quelle nuove o con un contenuto
// diverso: scorrendo di una riga se ne aggiunge una (non si ridisegnano tutte con i loghi), la
// guida in arrivo cambia solo le righe interessate e la riga scelta col telecomando resta attiva.
const drawn = new Map();
const rowTpl = document.createElement('template');

function renderList(force) {
  const total = S.filtered.length;
  spacer.style.height = total * ROW_H + 'px';
  const viewH = scroller.clientHeight || 600;
  const first = Math.floor(scroller.scrollTop / ROW_H);
  const start = Math.max(0, first - OVERSCAN);
  const count = Math.min(MAX_ROWS, Math.ceil(viewH / ROW_H) + OVERSCAN * 2);
  const end = Math.min(total, start + count);
  if (!force && start === V.start && end === V.end) return;
  V.start = start; V.end = end;
  const a = document.activeElement;
  const focusRow = a && a !== rowsLayer && rowsLayer.contains(a) ? a.closest('[data-idx]') : null;
  for (const [i, r] of drawn) if (i < start || i >= end) { r.el.remove(); drawn.delete(i); }
  const terms = searchTerms();
  let prev = null;
  for (let i = start; i < end; i++) {
    let r = drawn.get(i);
    // solo scorrimento: le righe già disegnate restano come sono
    if (r && !force) { prev = r.el; continue; }
    const html = rowHtml(S.filtered[i], i, terms);
    if (!r || r.html !== html) {
      rowTpl.innerHTML = html;
      const el = rowTpl.content.firstElementChild;
      // in ordine nel documento, come le righe sullo schermo (ordine del Tab)
      if (r) r.el.replaceWith(el); else if (prev) prev.after(el); else rowsLayer.prepend(el);
      r = { el, html };
      drawn.set(i, r);
    }
    prev = r.el;
  }
  // col telecomando (o la tastiera), non dopo un clic del mouse
  if (focusRow && !rowsLayer.contains(document.activeElement) && (PLATFORM.tv || a.matches(':focus-visible'))) {
    const r = drawn.get(+focusRow.dataset.idx);
    if (r) (a === focusRow ? r.el : r.el.querySelector('.fav-btn') || r.el).focus({ preventScroll: true });
  }
  if (S.mode === 'live') scheduleRowEpg();
}

// apre la scheda della serie oppure riproduce canale o film
function activateItem(it) {
  if (S.mode === 'series') openDetail('series', it);
  // TV: OK sul canale già in onda lo mostra a schermo intero invece di riavviarlo (con un errore
  // a video, invece, lo riprova)
  else if (PLATFORM.tv && S.mode === 'live' && isPlayingRow(it) && !fsElement() && $('player-error').classList.contains('hidden')) {
    // uno zapping in attesa (CH+ e subito OK sul canale in onda) non parte più
    if (ZAP.timer) { cancelZap(); renderList(true); }
    toggleFullscreen();
  }
  else playItem(it, S.mode);
}

// Chromium emette al massimo un evento scroll per frame: il render è già limitato.
scroller.addEventListener('scroll', () => renderList(false), { passive: true });
window.addEventListener('resize', debounce(() => renderList(true), 100));
rowsLayer.addEventListener('error', (ev) => {
  const t = ev.target;
  if (t && t.tagName === 'IMG' && t.parentElement) {
    const span = t.parentElement.querySelector('span.hidden');
    if (span) span.classList.remove('hidden');
    t.remove();
  }
}, true);
rowsLayer.addEventListener('click', (ev) => {
  const favBtn = ev.target.closest('[data-fav]');
  if (favBtn) { ev.stopPropagation(); const it = S.filtered[+favBtn.dataset.fav]; if (it) toggleFav(S.mode, it); return; }
  const row = ev.target.closest('[data-idx]');
  if (row) { const it = S.filtered[+row.dataset.idx]; if (it) activateItem(it); }
});

function scrollToIndex(idx) {
  const top = idx * ROW_H, bottom = top + ROW_H;
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
}

// Zapping con ↑/↓ (e tasti canale): ogni pressione mostra subito il canale (titolo in alto,
// riga nella lista), lo stream parte quando i tasti si fermano per ZAP_DELAY ms. Attraversando
// più canali di fila non si apre e chiude una connessione al provider per ciascuno (con un solo
// collegamento consentito il server rifiuterebbe i successivi) e il box non si blocca.
const ZAP_DELAY = PLATFORM.android ? 400 : 250;
const ZAP = { idx: -1, item: null, timer: null };
// annullato da ogni altro avvio (OK su una riga, numero, Backspace) e dallo stop
function cancelZap() {
  if (!ZAP.timer) return;
  clearTimeout(ZAP.timer);
  ZAP.timer = null; ZAP.idx = -1; ZAP.item = null;
}
function stepChannel(delta) {
  // nelle serie ↑/↓ scorrono gli episodi della serie in riproduzione
  if (S.current && S.current._kind === 'episode') { stepEpisode(delta); return; }
  if (S.mode === 'series' || !S.filtered.length) return;
  const n = S.filtered.length;
  // si parte dal canale scelto con lo zapping in corso, altrimenti da quello in riproduzione
  let idx = -1;
  if (ZAP.timer) idx = S.filtered[ZAP.idx] === ZAP.item ? ZAP.idx : S.filtered.indexOf(ZAP.item);
  if (idx === -1 && S.current && S.currentMode === S.mode) idx = S.filtered.findIndex((s) => s.stream_id === S.current.stream_id);
  idx = idx === -1 ? (delta > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, idx + delta));
  const item = S.filtered[idx], mode = S.mode;
  clearTimeout(ZAP.timer);
  ZAP.idx = idx; ZAP.item = item;
  ZAP.timer = setTimeout(() => {
    cancelZap();
    // tornati sul canale in onda (↓ poi ↑), oppure passati ad altro (Film, Home): non si riapre nulla
    const same = S.current === item && S.currentMode === mode;
    if (same || S.mode !== mode || S.view !== 'live') { renderList(true); if (same) showOsdTop(item, mode); return; }
    playItem(item, mode);
  }, ZAP_DELAY);
  scrollToIndex(idx);
  renderList(true);
  showOsdTop(item, S.mode);
}

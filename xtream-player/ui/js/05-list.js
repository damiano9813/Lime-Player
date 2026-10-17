// Lista virtualizzata dei canali e dei film.
'use strict';

// ------------------------------------------------------------------ lista virtualizzata
const ROW_H = 60, MAX_ROWS = 100, OVERSCAN = 8;
const V = { start: -1, end: -1 };
const scroller = $('list-scroller'), spacer = $('list-spacer'), rowsLayer = $('list-rows');

const { highlight } = XPCore;

function rowHtml(it, idx, terms) {
  const active = S.current && S.currentMode === S.mode && S.current.stream_id === it.stream_id;
  const fav = isFav(S.mode, it.stream_id);
  const icon = it.stream_icon && /^https?:\/\//i.test(it.stream_icon)
    ? `<img src="${escapeHtml(it.stream_icon)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="w-full h-full object-contain" alt=""><span class="hidden">${escapeHtml(initials(it.name))}</span>`
    : `<span>${escapeHtml(initials(it.name))}</span>`;
  let sub;
  if (S.mode === 'vod') {
    const resume = lsGet('xp.resume.' + it.stream_id, 0);
    sub = [it.container_extension ? it.container_extension.toUpperCase() : '', it.rating > 0 ? '★ ' + Number(it.rating).toFixed(1) : '',
      resume > 30 ? 'riprendi da ' + fmtTime(resume) : ''].filter(Boolean).join(' · ');
  } else {
    sub = isVirtualCat(S.selectedCat[S.mode]) ? (S.catNames[S.mode].get(it.category_id) || '') : '';
  }
  const lead = active ? `<span class="w-9 flex justify-end shrink-0">${ICONS.eq.replace('class="eq"', `class="eq${video.paused ? ' paused' : ''}"`)}</span>`
    : `<span class="w-9 text-right text-[11px] tabular-nums text-zinc-600 shrink-0">${escapeHtml(it.num || idx + 1)}</span>`;
  return `<div data-idx="${idx}" title="${escapeHtml(it.name)}" class="vrow absolute left-0 right-0 flex items-center gap-3 px-3 cursor-pointer hover:bg-zinc-900 ${active ? 'row-active' : ''}" style="top:${idx * ROW_H}px;height:${ROW_H}px">
    ${lead}
    <div class="w-10 h-10 rounded-md bg-zinc-800/80 shrink-0 overflow-hidden flex items-center justify-center text-[11px] font-semibold text-zinc-400">${icon}</div>
    <div class="flex-1 min-w-0">
      <div class="text-sm truncate ${active ? 'text-indigo-200 font-medium' : 'text-zinc-200'}">${highlight(it.name, terms)}</div>
      ${sub ? `<div class="text-[11px] text-zinc-500 truncate">${escapeHtml(sub)}</div>` : ''}
    </div>
    <button data-fav="${idx}" class="fav-btn p-1.5 rounded-md shrink-0 ${fav ? 'is-fav text-amber-400' : 'text-zinc-500 hover:text-zinc-200'}" title="${fav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}" aria-label="${fav ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti'}">${fav ? ICONS.star : ICONS.starO}</button>
  </div>`;
}

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
  let html = '';
  const terms = searchTerms();
  for (let i = start; i < end; i++) html += rowHtml(S.filtered[i], i, terms);
  rowsLayer.innerHTML = html;
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
  if (row) { const it = S.filtered[+row.dataset.idx]; if (it) playItem(it, S.mode); }
});

function scrollToIndex(idx) {
  const top = idx * ROW_H, bottom = top + ROW_H;
  if (top < scroller.scrollTop) scroller.scrollTop = top;
  else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
}

function stepChannel(delta) {
  if (!S.filtered.length) return;
  let idx = S.current && S.currentMode === S.mode ? S.filtered.findIndex((s) => s.stream_id === S.current.stream_id) : -1;
  idx = idx === -1 ? (delta > 0 ? 0 : S.filtered.length - 1) : Math.min(S.filtered.length - 1, Math.max(0, idx + delta));
  scrollToIndex(idx);
  playItem(S.filtered[idx], S.mode);
}

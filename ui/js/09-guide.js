// Guida TV a griglia: i canali della lista attuale (categoria scelta e ricerca) in righe, gli
// orari di un giorno in colonne. Fonte principale la guida completa di xmltv.php (guide.rs:
// una sola richiesta, salvata su disco); per i canali che non vi compaiono, o se il server non
// la offre, la guida del singolo canale (get_epg_day), chiesta solo per le righe visibili.
'use strict';

const GUIDE_ROW_H = 56, GUIDE_HEAD_H = 34, GUIDE_CH_W = 224, GUIDE_OVERSCAN = 10;
// 4 px al minuto: mezz'ora = 120 px, un giorno ≈ 5760 px
const GUIDE_PX = 4 / 60, GUIDE_TICK = 1800;
const gScroller = $('guide-scroller'), gCanvas = $('guide-canvas'), gHead = $('guide-head'), gRows = $('guide-rows'), gNow = $('guide-now-line');
const G = {
  open: false, acct: '', days: [], day: 0, start: -1, end: -1, span: null, rows: [], timer: null, busy: false, seq: 0,
  // guida completa: null (da caricare) | 'loading' | 'ready' | 'error'
  full: null, fullError: '', fullInfo: null, progress: null,
  // `${inizio del giorno}|${stream_id}` -> programmi dalla guida completa
  data: new Map(), asked: new Set(),
  // guida per canale (tutti i giorni): stream_id -> programmi, oppure 'queued' in attesa
  perChannel: new Map(), queue: [], active: 0,
};

const guideOpen = () => G.open;
const guideDay = () => G.days[G.day];

function resetGuide() {
  G.seq += 1;
  G.full = null; G.fullError = ''; G.fullInfo = null; G.progress = null;
  G.data.clear(); G.asked.clear(); G.perChannel.clear(); G.queue = [];
}

// ------------------------------------------------------------------ apertura e chiusura
function openGuide() {
  if (G.open || S.mode !== 'live' || !S.creds) return;
  if (G.acct !== S.acct) { resetGuide(); G.acct = S.acct; }
  if (theaterOn()) setTheater(false);
  closeTracksMenu();
  G.open = true;
  $('app-view').classList.add('guide-open');
  $('guide-view').classList.remove('hidden');
  buildGuideDays();
  renderGuideFrame();
  scrollGuideToNow();
  gScroller.focus({ preventScroll: true });
  loadFullGuide(false);
  clearInterval(G.timer);
  G.timer = setInterval(tickGuide, 30000);
}

function closeGuide() {
  if (!G.open) return;
  G.open = false;
  clearInterval(G.timer);
  $('app-view').classList.remove('guide-open');
  $('guide-view').classList.add('hidden');
  gRows.innerHTML = '';
  G.rows = []; G.start = G.end = -1; G.span = null;
  // la lista era nascosta: va ridisegnata con le misure vere
  renderList(true);
  locateCurrent(false);
}

// lista cambiata (categoria, ricerca, aggiornamento in background)
function onGuideListChanged(resetScroll) {
  if (!G.open) return;
  if (S.mode !== 'live') { closeGuide(); return; }
  if (resetScroll) gScroller.scrollTop = 0;
  buildGuideDays();
  renderGuideFrame();
}

// ------------------------------------------------------------------ giorni
function buildGuideDays() {
  const cur = guideDay();
  G.days = XPCore.guideDays(nowSec(), XPCore.guidePastDays(S.filtered), 3);
  let i = cur ? G.days.findIndex((d) => d.from === cur.from) : -1;
  if (i === -1) i = G.days.findIndex((d) => d.offset === 0);
  G.day = i;
  $('guide-days').innerHTML = G.days.map((d, k) => {
    const on = k === G.day;
    return `<button data-day="${k}" role="tab" aria-selected="${on}" class="btn btn-sm shrink-0 ${on ? 'bg-accent-soft text-accent-ink border-accent' : 'btn-secondary'}">${escapeHtml(d.label)}</button>`;
  }).join('');
}

function selectGuideDay(k) {
  if (!G.days[k] || k === G.day) return;
  // stessa ora del giorno: comodo per confrontare le serate
  const left = gScroller.scrollLeft;
  G.day = k;
  buildGuideDays();
  renderGuideFrame();
  gScroller.scrollLeft = left;
  const sel = $('guide-days').querySelector('[aria-selected="true"]');
  if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function scrollGuideToNow() {
  const today = G.days.findIndex((d) => d.offset === 0);
  if (today !== -1 && today !== G.day) { G.day = today; buildGuideDays(); renderGuideFrame(); }
  const d = guideDay();
  const x = (nowSec() - d.from) * GUIDE_PX;
  gScroller.scrollLeft = Math.max(0, x - Math.max(0, gScroller.clientWidth - GUIDE_CH_W) * 0.2);
}

// ------------------------------------------------------------------ disegno
const guideWidth = (d) => (d.to - d.from) * GUIDE_PX;

function renderGuideFrame() {
  const d = guideDay();
  const w = guideWidth(d), total = S.filtered.length;
  gCanvas.style.width = GUIDE_CH_W + w + 'px';
  gCanvas.style.height = GUIDE_HEAD_H + total * GUIDE_ROW_H + 'px';
  renderGuideHead();
  const cat = categoryLabel(S.mode, S.selectedCat[S.mode]);
  const info = G.fullInfo ? `guida completa del ${new Date(G.fullInfo.fetched_at * 1000).toLocaleString('it-IT', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
  $('guide-sub').textContent = [cat, `${total.toLocaleString('it-IT')} canali`, S.search.trim() ? `ricerca “${S.search.trim()}”` : '', info].filter(Boolean).join('  ·  ');
  const empty = $('guide-empty');
  empty.classList.toggle('hidden', total > 0);
  empty.textContent = total ? '' : 'Nessun canale in questa lista: scegli un\'altra categoria dalla barra laterale.';
  renderGuideRows(true);
}

function renderGuideHead() {
  const d = guideDay(), now = nowSec();
  const w = guideWidth(d);
  gHead.style.height = GUIDE_HEAD_H + 'px';
  gHead.style.width = GUIDE_CH_W + w + 'px';
  const ticks = XPCore.timeTicks(d.from, d.to, GUIDE_TICK).map((t) =>
    `<span class="absolute top-0 h-full flex items-center pl-2 border-l border-line text-[11px] font-semibold tabular-nums text-ink-subtle" style="left:${(t - d.from) * GUIDE_PX}px">${fmtClock(t)}</span>`).join('');
  const isToday = now >= d.from && now < d.to;
  const nowTag = isToday ? `<span class="badge badge-live absolute top-1/2 -translate-x-1/2 -translate-y-1/2 z-10" style="left:${(now - d.from) * GUIDE_PX}px">${fmtClock(now)}</span>` : '';
  gHead.innerHTML = `<div class="sticky left-0 z-20 shrink-0 flex items-center px-3 bg-s1 border-r border-line overline" style="width:${GUIDE_CH_W}px">${escapeHtml(d.label)}</div>
    <div class="relative flex-1">${ticks}${nowTag}</div>`;
  gNow.classList.toggle('hidden', !isToday);
  if (isToday) {
    gNow.style.left = GUIDE_CH_W + (now - d.from) * GUIDE_PX - 1 + 'px';
    gNow.style.height = GUIDE_HEAD_H + S.filtered.length * GUIDE_ROW_H + 'px';
  }
}

function renderGuideRows(force) {
  if (!G.open) return;
  const total = S.filtered.length;
  const viewH = Math.max(0, (gScroller.clientHeight || 600) - GUIDE_HEAD_H);
  // si ridisegna solo quando la parte visibile esce da quella già disegnata (righe e orari in più
  // attorno): in orizzontale solo i blocchi entro una vista prima e dopo
  const vis = XPCore.visibleRows(gScroller.scrollTop, viewH, GUIDE_ROW_H, total, 0);
  const left = gScroller.scrollLeft, viewW = Math.max(400, gScroller.clientWidth - GUIDE_CH_W);
  const inside = vis.start >= G.start && vis.end <= G.end && G.span && left >= G.span[0] && left + viewW <= G.span[1];
  if (!force && inside) return;
  const { start, end } = XPCore.visibleRows(gScroller.scrollTop, viewH, GUIDE_ROW_H, total, GUIDE_OVERSCAN);
  const span = [left - viewW, left + 2 * viewW];
  G.start = start; G.end = end; G.span = span;
  const d = guideDay(), now = nowSec(), w = guideWidth(d);
  G.rows = [];
  let html = '';
  for (let i = start; i < end; i++) html += guideRowHtml(S.filtered[i], i, d, now, w, span);
  gRows.innerHTML = html;
  requestGuideData();
}
const rerenderGuide = debounce(() => renderGuideRows(true), 80);

function guideEntries(ch, d) {
  const k = d.from + '|' + ch.stream_id;
  if (G.data.has(k)) return G.data.get(k);
  const pc = G.perChannel.get(String(ch.stream_id));
  return Array.isArray(pc) ? pc : null;
}

function guideRowHtml(ch, i, d, now, w, span) {
  const entries = guideEntries(ch, d);
  const blocks = entries ? XPCore.layoutPrograms(entries, d.from, d.to, GUIDE_PX) : [];
  G.rows[i] = { ch, blocks };
  const playing = !!S.current && S.currentMode === 'live' && S.current.stream_id === ch.stream_id;
  const cu = S.current && S.current._catchup && S.current._channel && S.current._channel.stream_id === ch.stream_id ? S.current._entry.start_ts : null;
  let progs = '';
  blocks.forEach((b, j) => {
    if (b.x + b.w < span[0] || b.x > span[1]) return;
    const e = b.e, st = XPCore.programState(e, now, ch);
    const click = st === 'live' || st === 'archive';
    const on = (st === 'live' && playing) || (cu != null && Math.abs(e.start_ts - cu) < 120);
    const title = e.title || 'Senza titolo';
    const time = `${fmtClock(e.start_ts)} – ${fmtClock(e.end_ts)}`;
    const hint = st === 'live' ? 'In onda: clic per guardare' : st === 'archive' ? 'Clic per rivedere (catch-up)' : '';
    const tip = [title, time, hint, e.description].filter(Boolean).join('\n');
    const text = b.w >= 30 ? `<span class="block text-xs font-bold truncate ${st === 'archive' && b.w > 70 ? 'pr-4' : ''}">${escapeHtml(title)}</span><span class="block text-[11px] font-medium tabular-nums truncate opacity-75">${time}</span>` : '';
    const icon = st === 'archive' && b.w > 70 ? `<span class="gp-icon">${ICONS.rewind}</span>` : '';
    const bar = st === 'live' ? `<span class="gp-bar" style="width:${XPCore.epgProgress(e, now) * 100}%"></span>` : '';
    const attrs = click ? `type="button" data-gr="${i}" data-gp="${j}"` : '';
    const tag = click ? 'button' : 'div';
    progs += `<${tag} ${attrs} class="gp gp-${st}${on ? ' playing' : ''}" style="left:${b.x}px;width:${Math.max(2, b.w - 2)}px" title="${escapeHtml(tip)}">${text}${icon}${bar}</${tag}>`;
  });
  if (!blocks.length) {
    const msg = !entries ? 'Caricamento della guida…' : 'Nessun programma nella guida per questo giorno';
    progs = `<span class="sticky inline-flex items-center h-full px-3 text-[11px] font-medium text-ink-subtle" style="left:${GUIDE_CH_W}px">${msg}</span>`;
  }
  const icon = ch.stream_icon && /^https?:\/\//i.test(ch.stream_icon)
    ? `<img src="${escapeHtml(ch.stream_icon)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" class="w-full h-full object-contain" alt=""><span class="hidden">${escapeHtml(initials(ch.name))}</span>`
    : `<span>${escapeHtml(initials(ch.name))}</span>`;
  const lead = playing ? ICONS.eq.replace('class="eq"', `class="eq${video.paused ? ' paused' : ''}"`) : escapeHtml(ch.num || i + 1);
  const archive = String(ch.tv_archive) === '1' ? `<span class="shrink-0 text-ink-subtle" title="Catch-up: programmi passati disponibili">${ICONS.rewind}</span>` : '';
  return `<div class="grow absolute left-0 flex" style="top:${GUIDE_HEAD_H + i * GUIDE_ROW_H}px;height:${GUIDE_ROW_H}px;width:${GUIDE_CH_W + w}px">
    <div data-gch="${i}" class="gch ${playing ? 'on' : ''} sticky left-0 z-10 shrink-0 flex items-center gap-2.5 pl-2 pr-3 cursor-pointer" style="width:${GUIDE_CH_W}px" title="${escapeHtml(ch.name)}: clic per guardare">
      <span class="w-7 flex justify-end text-[11px] font-semibold tabular-nums text-ink-subtle shrink-0">${lead}</span>
      <div class="logo-tile w-9 h-9 rounded-lg shrink-0 overflow-hidden flex items-center justify-center text-[11px] font-extrabold text-ink-muted">${icon}</div>
      <span class="flex-1 min-w-0 text-sm truncate ${playing ? 'text-accent-ink font-bold' : 'text-ink font-medium'}">${escapeHtml(ch.name)}</span>
      ${archive}
    </div>
    <div class="gtl relative flex-1" style="background-size:${GUIDE_TICK * GUIDE_PX}px 100%">${progs}</div>
  </div>`;
}

// ogni 30 s: linea dell'ora, programmi in onda, cambio di giorno dopo la mezzanotte
function tickGuide() {
  if (!G.open) return;
  const today = G.days.find((d) => d.offset === 0);
  if (!today || nowSec() >= today.to) buildGuideDays();
  renderGuideHead();
  renderGuideRows(true);
}

// ------------------------------------------------------------------ dati
function guideStatusHtml() {
  if (G.full === 'loading') {
    const p = G.progress;
    const mb = (n) => (n / 1048576).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' MB';
    const size = p ? mb(p.bytes) + (p.total ? ' di ' + mb(p.total) : '') : '';
    const what = p && p.parsing ? `Lettura della guida (${size})…` : `Download della guida TV completa${size ? ': ' + size : '…'}`;
    return `<svg class="w-4 h-4 text-accent spin shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"/></svg>
      <span class="text-ink">${escapeHtml(what)}</span><span class="text-ink-subtle">La prima volta può richiedere qualche minuto, poi resta salvata su questo PC.</span>`;
  }
  if (G.full === 'error') {
    return `${TOAST_ICONS.info}<span class="flex-1 min-w-0 truncate" title="${escapeHtml(G.fullError)}">${escapeHtml(G.fullError.replace(/[.\s]+$/, ''))}. Si usa la guida dei singoli canali.</span>
      <button id="guide-retry" class="btn btn-ghost btn-sm shrink-0">Riprova</button>`;
  }
  return '';
}
function renderGuideStatus() {
  const el = $('guide-status');
  const html = guideStatusHtml();
  el.classList.toggle('hidden', !html);
  el.innerHTML = html;
}

async function loadFullGuide(refresh) {
  if (G.full === 'loading' || (G.full && !refresh)) { requestGuideData(); return; }
  const seq = G.seq;
  G.full = 'loading'; G.progress = null;
  renderGuideStatus();
  renderGuideRows(true);
  try {
    const info = await invoke('load_guide', { ...S.creds, cache: refresh ? 'refresh' : 'prefer' });
    if (seq !== G.seq) return;
    G.full = 'ready'; G.fullInfo = info;
    G.data.clear(); G.asked.clear();
  } catch (e) {
    if (seq !== G.seq) return;
    G.full = 'error'; G.fullError = errText(e);
  }
  renderGuideStatus();
  if (G.open) renderGuideFrame();
}

// righe visibili senza programmi: prima la guida completa, poi quella del canale
const requestGuideData = debounce(async () => {
  if (!G.open || !S.creds || !G.full || G.full === 'loading') return;
  const d = guideDay(), seq = G.seq;
  const want = [];
  for (let i = G.start; i < G.end; i++) {
    const ch = S.filtered[i];
    if (!ch) continue;
    const k = d.from + '|' + ch.stream_id;
    if (G.data.has(k) || G.asked.has(k) || G.perChannel.has(String(ch.stream_id))) continue;
    G.asked.add(k);
    if (G.full === 'ready' && ch.epg_channel_id) want.push(ch);
    else queueChannelEpg(ch, i, k);
  }
  if (want.length) {
    let res = null;
    try {
      res = await invoke('get_guide_programmes', {
        server: S.creds.server, username: S.creds.username,
        channelIds: Array.from(new Set(want.map((c) => c.epg_channel_id))), from: d.from, to: d.to,
      });
    } catch { res = null; }
    if (seq !== G.seq) return;
    want.forEach((ch) => {
      const list = res && res[ch.epg_channel_id];
      const k = d.from + '|' + ch.stream_id;
      // canale assente o senza programmi quel giorno: può averli la guida del canale (archivio)
      if (list && list.length) G.data.set(k, list);
      else queueChannelEpg(ch, S.filtered.indexOf(ch), k);
    });
    rerenderGuide();
  }
  pumpChannelEpg();
}, 150);

function queueChannelEpg(ch, idx, key) {
  const id = String(ch.stream_id);
  if (G.perChannel.has(id)) return;
  G.perChannel.set(id, 'queued');
  G.queue.push({ ch, idx, key });
}

function fetchChannelDay(ch) {
  return invoke('get_epg_day', { ...S.creds, streamId: String(ch.stream_id) }).catch(() => []);
}

// al massimo 3 richieste insieme; i canali usciti dalla vista si richiederanno quando tornano
function pumpChannelEpg() {
  while (G.active < 3 && G.queue.length) {
    const { ch, idx, key } = G.queue.shift();
    const id = String(ch.stream_id);
    if (!(idx >= G.start && idx < G.end && S.filtered[idx] === ch)) {
      G.perChannel.delete(id); G.asked.delete(key);
      continue;
    }
    const seq = G.seq;
    G.active += 1;
    fetchChannelDay(ch).then((list) => {
      if (seq !== G.seq) return;
      G.perChannel.set(id, list || []);
      rerenderGuide();
    }).finally(() => { G.active -= 1; pumpChannelEpg(); });
  }
}

// ------------------------------------------------------------------ clic
function watchGuideChannel(ch) {
  closeGuide();
  playItem(ch, 'live');
  locateCurrent(false);
}

async function activateGuideProgram(ch, e) {
  const st = XPCore.programState(e, nowSec(), ch);
  if (st === 'live') { watchGuideChannel(ch); return; }
  if (st !== 'archive' || G.busy) return;
  G.busy = true;
  try {
    // /timeshift/ vuole l'orario del server: lo dà la guida del canale (get_simple_data_table)
    const m = XPCore.matchProgram(await fetchChannelDay(ch), e.start_ts);
    const entry = m ? { ...m, title: m.title || e.title, description: m.description || e.description } : e;
    if (!XPCore.timeshiftStart(entry.start)) { toast('Orario del programma non disponibile per il catch-up', 'error'); return; }
    if (!G.open) return;
    closeGuide();
    playCatchup(ch, entry);
  } finally {
    G.busy = false;
  }
}

// ------------------------------------------------------------------ eventi
$('list-guide').addEventListener('click', openGuide);
$('guide-close').addEventListener('click', closeGuide);
$('guide-now-btn').addEventListener('click', scrollGuideToNow);
$('guide-days').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-day]');
  if (b) selectGuideDay(+b.dataset.day);
});
$('guide-status').addEventListener('click', (ev) => {
  if (ev.target.closest('#guide-retry')) { G.full = null; loadFullGuide(true); }
});
gScroller.addEventListener('scroll', () => renderGuideRows(false), { passive: true });
window.addEventListener('resize', debounce(() => { if (G.open) renderGuideRows(true); }, 100));
gRows.addEventListener('error', (ev) => {
  const t = ev.target;
  if (t && t.tagName === 'IMG' && t.parentElement) {
    const span = t.parentElement.querySelector('span.hidden');
    if (span) span.classList.remove('hidden');
    t.remove();
  }
}, true);
gRows.addEventListener('click', (ev) => {
  const p = ev.target.closest('[data-gp]');
  if (p) {
    const r = G.rows[+p.dataset.gr], b = r && r.blocks[+p.dataset.gp];
    if (b) activateGuideProgram(r.ch, b.e);
    return;
  }
  const c = ev.target.closest('[data-gch]');
  if (c) { const r = G.rows[+c.dataset.gch]; if (r) watchGuideChannel(r.ch); }
});
if (TAURI && TAURI.event) {
  TAURI.event.listen('guide-progress', (e) => {
    if (G.full !== 'loading') return;
    G.progress = e.payload;
    renderGuideStatus();
  }).catch(() => {});
  // guida riscaricata in background (più vecchia di 6 ore)
  TAURI.event.listen('guide-updated', (e) => {
    if (G.full !== 'ready') return;
    G.fullInfo = e.payload;
    G.data.clear(); G.asked.clear();
    if (G.open) renderGuideFrame();
  }).catch(() => {});
}

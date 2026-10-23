// Sincronizzazione tra dispositivi (PC, telefono, TV) tramite Supabase, cifrata end-to-end.
// Logica e crittografia in sync-core.js (XPSync); server in supabase/schema.sql.
//
// Si sincronizzano le playlist (con la password), e per ogni playlist preferiti, recenti,
// posizioni di ripresa e ultimo episodio delle serie, più le lingue preferite. Ogni voce porta
// la data dell'ultima modifica: vince la più recente. Le modifiche locali passano da lsSet/lsDel
// (01-base.js), che avvisano questo modulo con onStoreWrite.
'use strict';

const SYNC_SERVER = window.XP_SYNC_SERVER || {};
const syncConfigured = () => !!(SYNC_SERVER.url && SYNC_SERVER.anonKey);
const SY = {
  keys: null,
  running: null,
  pushTimer: null,
  loopTimer: null,
  error: '',
  // scrittura di valori arrivati dal server: non sono modifiche locali
  applying: false,
};
const SYNC_INTERVAL = 60000;

// stato della sincronizzazione in localStorage (scritto senza passare da lsSet)
const rawGet = (k, def) => { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } };
const rawSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage pieno */ } };
const SK = { meta: 'xp.sync.meta', dirty: 'xp.sync.dirty', since: 'xp.sync.since', accts: 'xp.sync.accts', last: 'xp.sync.last' };
function resetSyncState() { Object.values(SK).forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignorato */ } }); }

// ------------------------------------------------------------------ server
async function rpc(fn, args) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(`${SYNC_SERVER.url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SYNC_SERVER.anonKey, Authorization: `Bearer ${SYNC_SERVER.anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
      signal: ctl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = '';
      try { msg = JSON.parse(text).message || ''; } catch { /* non JSON */ }
      throw new Error(msg || `il server ha risposto ${res.status}`);
    }
    return text ? JSON.parse(text) : null;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('il server di sincronizzazione non risponde');
    if (e instanceof TypeError) throw new Error('server di sincronizzazione non raggiungibile');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
const auth = () => ({ p_space: SY.keys.space, p_auth: SY.keys.auth });

// ------------------------------------------------------------------ modifiche locali
function markDirty(k, t) {
  const meta = rawGet(SK.meta, {}), dirty = rawGet(SK.dirty, {});
  meta[k] = t; dirty[k] = t;
  rawSet(SK.meta, meta); rawSet(SK.dirty, dirty);
}
onStoreWrite = (k) => {
  if (!SY.keys || SY.applying || !XPSync.isSyncedKey(k)) return;
  markDirty(k, Date.now());
  syncSoon(8000);
};
function syncSoon(ms) {
  if (!SY.keys) return;
  clearTimeout(SY.pushTimer);
  SY.pushTimer = setTimeout(() => syncNow(false), ms || 3000);
}

// valori salvati prima di attivare la sincronizzazione: vanno pubblicati con la loro data
function scanLocalKeys() {
  const meta = rawGet(SK.meta, {}), dirty = rawGet(SK.dirty, {});
  let n = 0;
  for (const k of lsKeys()) {
    if (!XPSync.isSyncedKey(k) || meta[k] != null) continue;
    const t = XPSync.valueTime(lsGet(k, null)) || 1;
    meta[k] = t; dirty[k] = t; n++;
  }
  if (n) { rawSet(SK.meta, meta); rawSet(SK.dirty, dirty); }
}

// playlist: il vault è in Rust, si confronta un'impronta di server, utente, password e nome
const accountHash = (c) => XPSync.sha256Hex(JSON.stringify([c.server, c.username, c.password, c.name || '']));
async function scanAccounts() {
  const list = await invoke('list_accounts');
  const snap = rawGet(SK.accts, {}), seen = {};
  for (const a of list) {
    const full = await invoke('load_account', { server: a.server, username: a.username }).catch(() => null);
    if (!full || !full.password) continue;
    const k = XPSync.accountItemKey(a);
    seen[k] = await accountHash(full);
    if (snap[k] !== seen[k]) markDirty(k, Date.now());
  }
  // tolta su questo dispositivo: si toglie anche dagli altri
  for (const k of Object.keys(snap)) if (!seen[k]) markDirty(k, Date.now());
  rawSet(SK.accts, seen);
}

async function localValue(k) {
  if (XPSync.isAccountItemKey(k)) {
    const [server, username] = k.slice(5).split('|');
    const full = await invoke('load_account', { server, username: username || '' }).catch(() => null);
    return full && full.password ? { server: full.server, username: full.username, password: full.password, name: full.name || '' } : null;
  }
  if (k === XPSync.SETTINGS_KEY) return XPSync.sharedSettings(S.settings);
  return lsGet(k, null);
}

// ------------------------------------------------------------------ ciclo
async function pull() {
  let since = rawGet(SK.since, 0);
  const meta = rawGet(SK.meta, {}), dirty = rawGet(SK.dirty, {});
  const changed = new Set();
  let accountsChanged = false;
  for (;;) {
    const rows = await rpc('xp_pull', { ...auth(), p_since: since });
    if (!Array.isArray(rows) || !rows.length) break;
    for (const row of rows) {
      since = Math.max(since, Number(row.seq) || 0);
      let item;
      try { item = await XPSync.open(SY.keys, row.data); } catch { continue; }
      const k = item && item.k;
      if (!k) continue;
      if (XPSync.isAccountItemKey(k)) {
        if ((Number(item.t) || 0) > (meta[k] || 0)) {
          if (await applyAccount(k, item)) accountsChanged = true;
          meta[k] = item.t; delete dirty[k];
        }
        continue;
      }
      if (!XPSync.isSyncedKey(k)) continue;
      const localV = k === XPSync.SETTINGS_KEY ? null : lsGet(k, null);
      const localT = meta[k] != null ? meta[k] : XPSync.valueTime(localV);
      const action = XPSync.resolve(k, { v: localV, t: localT }, item);
      SY.applying = true;
      try {
        if (action === 'take') {
          applyValue(k, item);
          meta[k] = item.t; delete dirty[k];
          changed.add(k);
        } else if (action === 'merge') {
          const max = /\.recent\./.test(k) ? RECENT_MAX : 0;
          lsSet(k, XPSync.unionList(item.v, localV, max));
          meta[k] = dirty[k] = Date.now();
          changed.add(k);
        } else if (localT > (Number(item.t) || 0)) {
          // la nostra è più recente: si ripubblica
          meta[k] = dirty[k] = localT;
        } else if (meta[k] == null) meta[k] = localT;
      } finally { SY.applying = false; }
    }
    if (rows.length < 1000) break;
  }
  rawSet(SK.meta, meta); rawSet(SK.dirty, dirty); rawSet(SK.since, since);
  if (accountsChanged) await refreshAccounts();
  if (changed.size) onSyncApplied(changed);
}

function applyValue(k, item) {
  if (k === XPSync.SETTINGS_KEY) {
    if (item.d || !item.v) return;
    Object.assign(S.settings, XPSync.sharedSettings(item.v));
    lsSet('xp.settings', S.settings);
    if (settingsPanelOpen()) renderSettings();
    return;
  }
  if (item.d) lsDel(k); else lsSet(k, item.v);
}

async function applyAccount(k, item) {
  const snap = rawGet(SK.accts, {});
  const [server, username] = k.slice(5).split('|');
  if (item.d) {
    if (!snap[k]) return false;
    await invoke('remove_account', { server, username: username || '' }).catch(() => {});
    delete snap[k];
  } else {
    const a = item.v || {};
    if (!a.server || !a.username || !a.password) return false;
    const h = await accountHash(a);
    if (snap[k] === h) return false;
    await invoke('import_account', { server: a.server, username: a.username, password: a.password, name: a.name || '' });
    snap[k] = h;
  }
  rawSet(SK.accts, snap);
  return true;
}

async function push() {
  const dirty = rawGet(SK.dirty, {});
  const entries = Object.entries(dirty);
  for (let i = 0; i < entries.length; i += 200) {
    const chunk = entries.slice(i, i + 200);
    const items = await Promise.all(chunk.map(async ([k, t]) => {
      const v = await localValue(k);
      const body = v == null ? { k, t, d: true, dev: PLATFORM.device } : { k, v, t, dev: PLATFORM.device };
      return { id: await XPSync.itemId(SY.keys, k), data: await XPSync.seal(SY.keys, body), t };
    }));
    await rpc('xp_push', { ...auth(), p_items: items });
    // tolte solo le voci non cambiate nel frattempo
    const now = rawGet(SK.dirty, {});
    for (const [k, t] of chunk) if (now[k] === t) delete now[k];
    rawSet(SK.dirty, now);
  }
}

function syncNow(manual) {
  if (!SY.keys) return Promise.resolve();
  if (SY.running) return SY.running;
  SY.running = (async () => {
    try {
      await scanAccounts();
      await pull();
      scanLocalKeys();
      await push();
      SY.error = '';
      rawSet(SK.last, Date.now());
      if (manual) toast('Sincronizzazione completata', 'ok');
    } catch (e) {
      SY.error = errText(e);
      if (manual) toast('Sincronizzazione non riuscita: ' + SY.error, 'error');
    } finally {
      SY.running = null;
      renderSyncSettings();
    }
  })();
  return SY.running;
}

// dati della playlist aperta arrivati da un altro dispositivo: si ridisegna quello che li mostra
function onSyncApplied(keys) {
  if (!S.acct) return;
  const prefix = `xp.a.${S.acct}.`;
  if (![...keys].some((k) => k.startsWith(prefix))) return;
  S.favorites = perMode((m) => lsGet(ak('fav.' + m), []));
  S.recent = perMode((m) => lsGet(ak('recent.' + m), []));
  if (S.liveReady && !browseVisible()) { renderCategories(); renderList(true); }
  updateFavButton();
  onFavChanged();
}

// ------------------------------------------------------------------ attivazione
async function enableSync(code) {
  const keys = await XPSync.deriveKeys(code);
  SY.keys = keys;
  try {
    await rpc('xp_join', auth());
  } catch (e) {
    SY.keys = null;
    throw e;
  }
  await invoke('save_sync_code', { code: keys.code });
  resetSyncState();
  // gruppo raggiunto e codice salvato: la sincronizzazione è attiva anche se il primo giro non
  // riesce (rete lenta, app occupata); il ciclo riprova da solo. Restituisce l'errore del primo giro.
  startSyncLoop();
  await syncNow(false);
  if (SY.error) syncSoon(15000);
  return SY.error;
}
const firstSyncNote = (err) => { if (err) toast(`Sincronizzazione attiva, ma il primo invio non è riuscito (${err}): riprovo tra poco`, 'error'); };

async function disableSync(wipe) {
  if (wipe && SY.keys) await rpc('xp_delete', auth());
  SY.keys = null;
  clearTimeout(SY.pushTimer);
  clearInterval(SY.loopTimer);
  resetSyncState();
  await invoke('save_sync_code', { code: null }).catch(() => {});
  renderSyncSettings();
}

function startSyncLoop() {
  clearInterval(SY.loopTimer);
  SY.loopTimer = setInterval(() => syncNow(false), SYNC_INTERVAL);
}
document.addEventListener('visibilitychange', () => { if (SY.keys) syncNow(false); });

// all'avvio, prima dell'elenco delle playlist: un dispositivo appena collegato le riceve subito
async function initSync() {
  renderSyncSettings();
  if (!syncConfigured()) return;
  let code = null;
  try { code = await invoke('load_sync_code'); } catch { code = null; }
  if (!code) return;
  try { SY.keys = await XPSync.deriveKeys(code); } catch { return; }
  startSyncLoop();
  await Promise.race([syncNow(false), new Promise((r) => setTimeout(r, 6000))]);
}

// ------------------------------------------------------------------ abbinamento
// Dispositivo nuovo (spesso la TV): mostra 8 cifre e aspetta il codice dall'altro dispositivo.
async function receivePairing() {
  if (!syncConfigured()) return;
  let code = '', kp;
  try {
    kp = await XPSync.pairKeyPair();
    for (let i = 0; i < 3 && !code; i++) {
      const c = XPSync.newPairCode();
      try { await rpc('xp_pair_start', { p_code: c, p_pubkey: kp.pub }); code = c; } catch (e) { if (i === 2) throw e; }
    }
  } catch (e) { toast('Collegamento non disponibile: ' + errText(e), 'error'); return; }
  const token = {};
  SY.pairToken = token;
  const shown = openModal('Collega questo dispositivo',
    `<p>Sul PC o sul telefono già sincronizzato apri <b class="text-ink">Impostazioni › Sincronizzazione › Collega un dispositivo</b> e inserisci:</p>
     <p class="mt-4 text-center font-mono text-4xl font-bold tracking-[0.2em] text-ink">${XPSync.formatPairCode(code)}</p>
     <p class="mt-4 text-xs text-ink-subtle">Il codice vale 10 minuti.</p>`,
    [{ label: 'Annulla', value: false }]);
  shown.then(() => { if (SY.pairToken === token) SY.pairToken = null; });
  const until = Date.now() + 10 * 60000;
  let reply = null;
  while (SY.pairToken === token && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2500));
    if (SY.pairToken !== token) return;
    try { reply = await rpc('xp_pair_poll', { p_code: code }); } catch { reply = null; }
    if (reply) break;
  }
  if (SY.pairToken !== token || !reply) { if (SY.pairToken === token) { closeModal(false); toast('Codice scaduto: riprova', 'error'); } return; }
  SY.pairToken = null;
  let payload, secret;
  try {
    const r = JSON.parse(reply);
    secret = await XPSync.pairSecret(kp.priv, r.pub, kp.pub, r.pub);
    payload = await XPSync.openWith(secret.key, r.box);
  } catch { closeModal(false); toast('Risposta di collegamento non valida', 'error'); return; }
  const ok = await openModal('Conferma il collegamento',
    `<p>Richiesta da <b class="text-ink">${escapeHtml(payload.from || 'un altro dispositivo')}</b>. Controlla che lì compaiano le stesse cifre:</p>
     <p class="mt-4 text-center font-mono text-3xl font-bold tracking-widest text-ink">${secret.sas}</p>`,
    [{ label: 'Annulla', value: false }, { label: 'Collega', value: true, primary: true }]);
  if (!ok) return;
  try {
    const err = await enableSync(payload.code);
    if (err) firstSyncNote(err);
    else toast('Dispositivo collegato: playlist e preferiti sincronizzati', 'ok');
    // dalla schermata delle playlist: si mostra l'elenco con quelle appena arrivate
    if (!$('login-view').classList.contains('hidden') && accounts.length) {
      setFormOpen(false);
      const first = $('acct-list').querySelector('[data-open]');
      if (first) first.focus();
    }
  } catch (e) { toast('Collegamento non riuscito: ' + errText(e), 'error'); }
}

// Dispositivo già sincronizzato: invia il codice al nuovo, cifrato con la sua chiave pubblica.
async function sendPairing() {
  if (!SY.keys) return;
  const ok = await openModal('Collega un dispositivo',
    `<p>Sul nuovo dispositivo (TV, telefono, PC) scegli <b class="text-ink">Ricevi da un altro dispositivo</b> e inserisci qui il codice che mostra.</p>
     <input id="pair-code" inputmode="numeric" autocomplete="off" maxlength="9" placeholder="0000 0000" class="field mt-4 text-center font-mono text-2xl tracking-widest">`,
    [{ label: 'Annulla', value: false }, { label: 'Collega', value: true, primary: true }]);
  if (!ok) return;
  const code = XPSync.cleanPairCode($('pair-code') && $('pair-code').value);
  if (!code) { toast('Il codice ha 8 cifre', 'error'); return; }
  try {
    const peer = await rpc('xp_pair_get', { p_code: code });
    if (!peer) { toast('Codice scaduto o errato', 'error'); return; }
    const kp = await XPSync.pairKeyPair();
    const secret = await XPSync.pairSecret(kp.priv, peer, kp.pub, peer);
    const box = await XPSync.sealWith(secret.key, { code: SY.keys.code, from: PLATFORM.device || 'un altro dispositivo' });
    const sent = await rpc('xp_pair_reply', { p_code: code, p_reply: JSON.stringify({ pub: kp.pub, box }) });
    if (!sent) { toast('Codice già usato o scaduto', 'error'); return; }
    openModal('Conferma sul nuovo dispositivo',
      `<p>Sul nuovo dispositivo devono comparire queste cifre: confermale lì per completare il collegamento.</p>
       <p class="mt-4 text-center font-mono text-3xl font-bold tracking-widest text-ink">${secret.sas}</p>`,
      [{ label: 'Fatto', value: true, primary: true }]);
  } catch (e) { toast('Collegamento non riuscito: ' + errText(e), 'error'); }
}

// ------------------------------------------------------------------ impostazioni
async function startSyncFlow() {
  const choice = await openModal('Attiva la sincronizzazione',
    `<p>Playlist (con le password), preferiti, recenti e punti di ripresa vengono cifrati su questo dispositivo e condivisi solo con quelli che hanno il tuo codice.</p>`,
    [{ label: 'Annulla', value: false }, { label: 'Ho già un codice', value: 'code' },
      { label: 'Ricevi da un altro dispositivo', value: 'pair' }, { label: 'Nuovo gruppo', value: 'new', primary: true }]);
  if (choice === 'pair') { receivePairing(); return; }
  if (choice === 'new') {
    try {
      const err = await enableSync(XPSync.newSyncCode());
      if (err) firstSyncNote(err); else toast('Sincronizzazione attiva', 'ok');
      showSyncCode();
    } catch (e) { toast('Attivazione non riuscita: ' + errText(e), 'error'); }
    return;
  }
  if (choice === 'code') {
    const ok = await openModal('Codice di sincronizzazione',
      `<p>Inserisci il codice mostrato da un dispositivo già sincronizzato (Impostazioni › Sincronizzazione › Mostra codice).</p>
       <input id="sync-code-input" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-…" class="field mt-4 font-mono uppercase">`,
      [{ label: 'Annulla', value: false }, { label: 'Usa il codice', value: true, primary: true }]);
    if (!ok) return;
    const parsed = XPSync.parseSyncCode($('sync-code-input') && $('sync-code-input').value);
    if (!parsed) { toast('Codice non valido: sono 32 caratteri', 'error'); return; }
    try {
      const err = await enableSync(parsed.code);
      if (err) firstSyncNote(err); else toast('Sincronizzazione attiva', 'ok');
    } catch (e) { toast('Attivazione non riuscita: ' + errText(e), 'error'); }
  }
}

function showSyncCode() {
  if (!SY.keys) return;
  const code = SY.keys.code;
  openModal('Codice di sincronizzazione',
    `<p>Chi ha questo codice vede le tue playlist e le password: non condividerlo. Per una TV è più comodo <b class="text-ink">Collega un dispositivo</b>.</p>
     <p class="mt-4 text-center font-mono text-lg font-bold text-ink break-words select-all">${escapeHtml(code)}</p>`,
    [{ label: 'Copia', value: 'copy' }, { label: 'Chiudi', value: true, primary: true }])
    .then(async (v) => { if (v === 'copy') toast((await copyText(code)) ? 'Codice copiato' : 'Copia non riuscita', 'ok'); });
}

async function confirmDisable() {
  const v = await openModal('Disattiva la sincronizzazione',
    '<p>Su questo dispositivo playlist e preferiti restano, ma non si aggiornano più. Puoi anche cancellare i dati dal server: gli altri dispositivi li ripubblicheranno alla prossima sincronizzazione.</p>',
    [{ label: 'Annulla', value: false }, { label: 'Cancella anche dal server', value: 'wipe', danger: true }, { label: 'Disattiva', value: 'off', primary: true }]);
  if (!v) return;
  try { await disableSync(v === 'wipe'); toast('Sincronizzazione disattivata', 'ok'); } catch (e) { toast(errText(e), 'error'); }
}

function renderSyncSettings() {
  const box = $('set-sync');
  if (!box) return;
  const loginBtn = $('login-sync');
  if (loginBtn) loginBtn.classList.toggle('hidden', !syncConfigured() || !!SY.keys);
  if (!syncConfigured()) {
    box.innerHTML = '<p class="set-help">Server di sincronizzazione non configurato in questa versione (vedi README, "Sincronizzazione").</p>';
    return;
  }
  if (!SY.keys) {
    box.innerHTML = `<div class="set-row"><div><p class="font-bold text-ink">Non attiva</p><p class="set-help">Playlist, preferiti e punti di ripresa uguali su PC, telefono e TV.</p></div>
      <button data-sync="start" class="btn btn-primary btn-sm">Attiva</button></div>`;
    return;
  }
  const last = rawGet(SK.last, 0);
  const when = last ? new Date(last).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'mai';
  const status = SY.running ? 'Sincronizzazione in corso…' : SY.error ? `<span class="text-accent-ink">Errore: ${escapeHtml(SY.error)}</span>` : `Ultima sincronizzazione: ${when}`;
  box.innerHTML = `<div class="set-row"><div><p class="font-bold text-success">Attiva</p><p class="set-help">${status}</p></div>
      <button data-sync="now" class="btn btn-secondary btn-sm" ${SY.running ? 'disabled' : ''}>Sincronizza ora</button></div>
    <div class="flex flex-wrap gap-2">
      <button data-sync="send" class="btn btn-secondary btn-sm">Collega un dispositivo</button>
      <button data-sync="code" class="btn btn-ghost btn-sm">Mostra codice</button>
      <button data-sync="off" class="btn btn-ghost btn-sm">Disattiva</button>
    </div>`;
}

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-sync]');
  if (!b) return;
  const act = b.dataset.sync;
  if (act === 'start') startSyncFlow();
  else if (act === 'now') { syncNow(true); renderSyncSettings(); }
  else if (act === 'send') sendPairing();
  else if (act === 'pair') receivePairing();
  else if (act === 'code') showSyncCode();
  else if (act === 'off') confirmDisable();
});

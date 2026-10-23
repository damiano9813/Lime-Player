// Costanti e stato condiviso dell'interfaccia.
'use strict';

// ------------------------------------------------------------------ stato
const ALL = '__all__', FAV = '__fav__', RECENT = '__recent__', MULTI = '__multi__';
// MULTI: più categorie insieme, quelle in S.multiCats
const isVirtualCat = (id) => id === ALL || id === FAV || id === RECENT || id === MULTI;
const RECENT_MAX = 40;
const MODE_API = {
  live: { cats: 'get_live_categories', streams: 'get_live_streams', label: 'Live TV', allLabel: 'Tutti i canali', unit: 'canali' },
  vod: { cats: 'get_vod_categories', streams: 'get_vod_streams', label: 'Film VOD', allLabel: 'Tutti i film', unit: 'film' },
  series: { cats: 'get_series_categories', streams: 'get_series', label: 'Serie TV', allLabel: 'Tutte le serie', unit: 'serie' },
};
const MODES = Object.keys(MODE_API);
const perMode = (fn) => Object.fromEntries(MODES.map((m) => [m, fn(m)]));
const S = {
  creds: null,
  // nome scelto per la playlist aperta (vuoto: si mostra l'username)
  acctName: '',
  account: null,
  proxy: null,
  // vista mostrata: 'home' | 'live' | 'vod' | 'series' (09b-browse.js)
  view: 'home',
  // lista, categorie e zapping della colonna centrale: solo Live TV (Film e Serie sono a righe)
  mode: 'live',
  // categorie e canali della Live TV si caricano alla prima apertura
  liveReady: false,
  categories: perMode(() => null),
  catNames: perMode(() => new Map()),
  // id dell'account collegato (XPCore.accountId): prefisso dei dati legati al provider
  acct: '',
  // categoria scelta, preferiti e recenti si caricano al login (loadAccountData)
  selectedCat: perMode(() => ALL),
  multiCats: perMode(() => []),
  cache: new Map(),
  listAge: new Map(),
  list: [],
  filtered: [],
  catFilter: '',
  search: '',
  current: null,
  currentMode: null,
  currentUrl: '',
  previous: null,
  favorites: perMode(() => []),
  recent: perMode(() => []),
  liveFormat: ['ts', 'm3u8', 'ffmpeg'].includes(lsGet('xp.liveFormat', 'ts')) ? lsGet('xp.liveFormat', 'ts') : 'ts',
  // impostazioni del pannello (audio, qualità, lingue, player esterno)
  settings: XPCore.normalizeSettings(lsGet('xp.settings', null)),
  loadSeq: 0,
};

// ------------------------------------------------------------------ dati per account
// chiave localStorage dei dati che dipendono dal provider (id di canali, film e serie)
const ak = (key) => XPCore.accountKey(S.acct, key);
// posizioni di ripresa e percorsi per canale crescono con ogni contenuto aperto
const STORE_LIMITS = { maxAgeMs: 180 * 86400000, maxCount: 500 };

// I dati delle versioni senza account passano al primo account che accede dopo l'aggiornamento.
// Una vecchia chiave presente dopo la migrazione l'ha scritta una versione precedente ancora
// aperta (stesso localStorage), quindi è la più recente e sostituisce quella dell'account.
function migrateLegacyData() {
  const now = Date.now();
  for (const [from, to] of XPCore.legacyKeyMoves(lsKeys(), S.acct)) {
    const v = lsGet(from, null);
    if (v != null) lsSet(to, XPCore.migratedValue(from, v, now));
    lsDel(from);
  }
}

// cancella le voci più vecchie di 180 giorni e, per tipo, quelle oltre le 500 più recenti (tutti gli account)
function pruneStoredData() {
  const groups = { resume: [], route: [] };
  for (const key of lsKeys()) {
    const kind = XPCore.prunableKind(key);
    if (!kind) continue;
    const v = lsGet(key, null);
    groups[kind].push({ key, t: (v && Number(v.t)) || 0 });
  }
  const now = Date.now();
  for (const list of Object.values(groups)) XPCore.staleEntries(list, now, STORE_LIMITS).forEach(lsDel);
}

function loadAccountData() {
  S.acct = XPCore.accountId(S.creds.server, S.creds.username);
  migrateLegacyData();
  pruneStoredData();
  S.selectedCat = perMode((m) => lsGet(ak('cat.' + m), ALL));
  S.multiCats = perMode((m) => { const v = lsGet(ak('cats.' + m), []); return Array.isArray(v) ? v.map(String) : []; });
  S.favorites = perMode((m) => lsGet(ak('fav.' + m), []));
  S.recent = perMode((m) => lsGet(ak('recent.' + m), []));
}

function unloadAccountData() {
  S.acct = '';
  S.selectedCat = perMode(() => ALL);
  S.multiCats = perMode(() => []);
  S.favorites = perMode(() => []);
  S.recent = perMode(() => []);
}

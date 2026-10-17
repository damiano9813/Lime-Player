// Costanti e stato condiviso dell'interfaccia.
'use strict';

// ------------------------------------------------------------------ stato
const ALL = '__all__', FAV = '__fav__', RECENT = '__recent__';
const isVirtualCat = (id) => id === ALL || id === FAV || id === RECENT;
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
  account: null,
  proxy: null,
  mode: MODES.includes(lsGet('xp.mode', 'live')) ? lsGet('xp.mode', 'live') : 'live',
  categories: perMode(() => null),
  catNames: perMode(() => new Map()),
  selectedCat: perMode((m) => lsGet('xp.cat.' + m, ALL)),
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
  favorites: perMode((m) => lsGet('xp.fav.' + m, [])),
  recent: perMode((m) => lsGet('xp.recent.' + m, [])),
  // serie aperta nella colonna centrale: { item, info, season }
  seriesView: null,
  liveFormat: ['ts', 'm3u8', 'ffmpeg'].includes(lsGet('xp.liveFormat', 'ts')) ? lsGet('xp.liveFormat', 'ts') : 'ts',
  loadSeq: 0,
};

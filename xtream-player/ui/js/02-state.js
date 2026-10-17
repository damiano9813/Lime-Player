// Costanti e stato condiviso dell'interfaccia.
'use strict';

// ------------------------------------------------------------------ stato
const ALL = '__all__', FAV = '__fav__', RECENT = '__recent__';
const isVirtualCat = (id) => id === ALL || id === FAV || id === RECENT;
const RECENT_MAX = 40;
const MODE_API = {
  live: { cats: 'get_live_categories', streams: 'get_live_streams', label: 'Live TV', allLabel: 'Tutti i canali', unit: 'canali' },
  vod: { cats: 'get_vod_categories', streams: 'get_vod_streams', label: 'Film VOD', allLabel: 'Tutti i film', unit: 'film' },
};
const S = {
  creds: null,
  account: null,
  proxy: null,
  mode: lsGet('xp.mode', 'live') === 'vod' ? 'vod' : 'live',
  categories: { live: null, vod: null },
  catNames: { live: new Map(), vod: new Map() },
  selectedCat: { live: lsGet('xp.cat.live', ALL), vod: lsGet('xp.cat.vod', ALL) },
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
  favorites: { live: lsGet('xp.fav.live', []), vod: lsGet('xp.fav.vod', []) },
  recent: { live: lsGet('xp.recent.live', []), vod: lsGet('xp.recent.vod', []) },
  liveFormat: ['ts', 'm3u8', 'ffmpeg'].includes(lsGet('xp.liveFormat', 'ts')) ? lsGet('xp.liveFormat', 'ts') : 'ts',
  loadSeq: 0,
};

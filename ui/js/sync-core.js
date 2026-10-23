// Sincronizzazione tra dispositivi: logica pura e crittografia (WebCrypto), senza DOM né Tauri.
// Caricata dalla pagina come script classico (window.XPSync) e dai test Node con require().
//
// Tutto ciò che va sul server è cifrato end-to-end. Dal codice di sincronizzazione (160 bit
// casuali, mostrato come 8 gruppi di 4 caratteri) si derivano con HKDF:
//   space  identificativo del gruppo sul server
//   auth   segreto che il server conosce solo come SHA-256 (chi non ha il codice non scrive)
//   enc    chiave AES-GCM dei dati
//   mac    chiave HMAC che nasconde i nomi delle chiavi (il server vede solo id opachi)
// L'abbinamento di un nuovo dispositivo (TV) usa ECDH P-256 effimero: la TV mostra un codice
// di 8 cifre, l'altro dispositivo le manda il codice di sincronizzazione cifrato e entrambi
// mostrano le stesse 6 cifre di verifica.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XPSync = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const cryptoApi = () => globalThis.crypto;
  const subtle = () => globalThis.crypto.subtle;
  const enc = new TextEncoder(), dec = new TextDecoder();

  // ------------------------------------------------------------------ codifiche
  // base32 di Crockford: niente I, L, O, U (si leggono senza ambiguità sullo schermo della TV)
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function b32encode(bytes) {
    let out = '', bits = 0, acc = 0;
    for (const b of bytes) {
      acc = (acc << 8) | b; bits += 8;
      while (bits >= 5) { bits -= 5; out += B32[(acc >>> bits) & 31]; }
    }
    if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
    return out;
  }
  function b32decode(text) {
    const s = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    const out = [];
    let bits = 0, acc = 0;
    for (const ch of s) {
      const v = B32.indexOf(ch);
      if (v < 0) return null;
      acc = ((acc << 5) | v) & 0xffff; bits += 5;
      if (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 255); }
    }
    return new Uint8Array(out);
  }
  const toB64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const fromB64 = (s) => Uint8Array.from(atob(String(s || '')), (c) => c.charCodeAt(0));
  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const randomBytes = (n) => cryptoApi().getRandomValues(new Uint8Array(n));

  // ------------------------------------------------------------------ codice di sincronizzazione
  const CODE_BYTES = 20;
  const formatCode = (raw) => raw.match(/.{1,4}/g).join('-');
  function newSyncCode() { return formatCode(b32encode(randomBytes(CODE_BYTES))); }
  // codice scritto a mano: maiuscole/minuscole, spazi e trattini indifferenti; null se non valido
  function parseSyncCode(text) {
    const bytes = b32decode(text);
    if (!bytes || bytes.length !== CODE_BYTES) return null;
    return { bytes, code: formatCode(b32encode(bytes)) };
  }

  async function hkdf(secret, info, length, salt) {
    const base = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveBits']);
    const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt || new Uint8Array(0), info: enc.encode(info) }, base, length * 8);
    return new Uint8Array(bits);
  }

  async function deriveKeys(code) {
    const parsed = parseSyncCode(code);
    if (!parsed) throw new Error('Codice di sincronizzazione non valido');
    const b = parsed.bytes;
    const [space, auth, encRaw, macRaw] = await Promise.all([
      hkdf(b, 'xp-sync space', 16), hkdf(b, 'xp-sync auth', 32), hkdf(b, 'xp-sync enc', 32), hkdf(b, 'xp-sync key', 32),
    ]);
    return {
      code: parsed.code,
      space: toHex(space),
      auth: toHex(auth),
      enc: await subtle().importKey('raw', encRaw, 'AES-GCM', false, ['encrypt', 'decrypt']),
      mac: await subtle().importKey('raw', macRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    };
  }

  // id opaco della chiave sul server
  async function itemId(keys, k) {
    const sig = new Uint8Array(await subtle().sign('HMAC', keys.mac, enc.encode(String(k))));
    return toHex(sig.slice(0, 16));
  }

  async function sealWith(key, obj) {
    const iv = randomBytes(12);
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv); out.set(ct, iv.length);
    return toB64(out);
  }
  async function openWith(key, data) {
    const raw = fromB64(data);
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return JSON.parse(dec.decode(pt));
  }
  const seal = (keys, obj) => sealWith(keys.enc, obj);
  const open = (keys, data) => openWith(keys.enc, data);

  // ------------------------------------------------------------------ abbinamento (ECDH)
  // 8 cifre: tentativi a caso inutili nei 10 minuti di validità
  function newPairCode() {
    const v = cryptoApi().getRandomValues(new Uint32Array(2));
    return String(v[0] % 10000).padStart(4, '0') + String(v[1] % 10000).padStart(4, '0');
  }
  const cleanPairCode = (s) => { const d = String(s || '').replace(/\D/g, ''); return d.length === 8 ? d : null; };
  const formatPairCode = (c) => `${c.slice(0, 4)} ${c.slice(4)}`;

  async function pairKeyPair() {
    const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const pub = toB64(new Uint8Array(await subtle().exportKey('raw', kp.publicKey)));
    return { priv: kp.privateKey, pub };
  }
  // chiave AES comune e cifre di verifica, uguali sui due dispositivi
  async function pairSecret(priv, peerPub, pubA, pubB) {
    const peer = await subtle().importKey('raw', fromB64(peerPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, priv, 256));
    const salt = enc.encode([pubA, pubB].sort().join('|'));
    const [keyRaw, sasRaw] = await Promise.all([hkdf(shared, 'xp-pair key', 32, salt), hkdf(shared, 'xp-pair sas', 4, salt)]);
    const n = ((sasRaw[0] << 24) | (sasRaw[1] << 16) | (sasRaw[2] << 8) | sasRaw[3]) >>> 0;
    const sas = String(n % 1000000).padStart(6, '0');
    return { key: await subtle().importKey('raw', keyRaw, 'AES-GCM', false, ['encrypt', 'decrypt']), sas: `${sas.slice(0, 3)} ${sas.slice(3)}` };
  }

  // ------------------------------------------------------------------ cosa si sincronizza
  // per account: preferiti, recenti, posizioni di ripresa e ultimo episodio delle serie
  // (categoria scelta e percorsi di riproduzione restano del dispositivo)
  const ACCOUNT_KEY_RE = /^xp\.a\.[0-9a-f]{8}\.((?:fav|recent)\.(?:live|vod|series)|(?:resume|series\.last)\..+)$/;
  const SETTINGS_KEY = 'xp.settings';
  // impostazioni comuni a tutti i dispositivi (motore, buffer e uscita audio dipendono dall'hardware)
  const SHARED_SETTINGS = ['audioLang', 'subLang'];
  const isSyncedKey = (k) => k === SETTINGS_KEY || ACCOUNT_KEY_RE.test(String(k));
  const isListKey = (k) => /\.(?:fav|recent)\.(?:live|vod|series)$/.test(String(k));
  const sharedSettings = (s) => Object.fromEntries(SHARED_SETTINGS.filter((n) => s && s[n] != null).map((n) => [n, s[n]]));

  // data di una voce senza metadati di sincronizzazione (prima attivazione): quella salvata nel valore
  const valueTime = (v) => (v && typeof v === 'object' && !Array.isArray(v) && Number(v.t) > 0 ? Number(v.t) : 0);

  // unione di due liste (preferiti o recenti): prima quelle del dispositivo remoto, senza doppioni
  function unionList(remote, local, max) {
    const out = [], seen = new Set();
    for (const it of [...(Array.isArray(remote) ? remote : []), ...(Array.isArray(local) ? local : [])]) {
      const id = it && it.stream_id != null ? String(it.stream_id) : null;
      if (id == null || seen.has(id)) continue;
      seen.add(id); out.push(it);
    }
    return max ? out.slice(0, max) : out;
  }

  // Decide cosa fare di una voce arrivata dal server.
  //   local: { v, t } con t = data della modifica locale (0: mai sincronizzata), v = valore attuale
  //   remote: { v, t, d } come pubblicata dall'altro dispositivo
  // -> 'keep' (vince la locale), 'take' (vince la remota), 'merge' (prima volta, liste: unione)
  function resolve(k, local, remote) {
    const lt = Number(local.t) || 0, rt = Number(remote.t) || 0;
    if (local.t === 0 && local.v != null && isListKey(k) && !remote.d) return 'merge';
    return rt > lt ? 'take' : 'keep';
  }

  // chiave della voce di una playlist (server e utente identificano l'account del provider)
  const accountItemKey = (a) => `acct:${String(a.server)}|${String(a.username)}`;
  const isAccountItemKey = (k) => String(k).startsWith('acct:');

  async function sha256Hex(text) {
    return toHex(new Uint8Array(await subtle().digest('SHA-256', enc.encode(String(text)))));
  }

  return {
    b32encode, b32decode, toB64, fromB64, newSyncCode, parseSyncCode, deriveKeys, itemId, seal, open,
    sealWith, openWith, newPairCode, cleanPairCode, formatPairCode, pairKeyPair, pairSecret,
    ACCOUNT_KEY_RE, SETTINGS_KEY, SHARED_SETTINGS, isSyncedKey, isListKey, sharedSettings, valueTime, unionList, resolve,
    accountItemKey, isAccountItemKey, sha256Hex,
  };
});

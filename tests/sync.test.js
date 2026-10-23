// Test della sincronizzazione (ui/js/sync-core.js): `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../ui/js/sync-core.js');

test('base32: andata e ritorno, lettere ambigue tollerate', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 128]);
  assert.deepEqual(X.b32decode(X.b32encode(bytes)), bytes);
  assert.equal(X.b32decode('ABU'), null);
  assert.deepEqual(X.b32decode('o1'), X.b32decode('01'));
  assert.deepEqual(X.b32decode('IL'), X.b32decode('11'));
});

test('codice di sincronizzazione: formato e lettura', () => {
  const code = X.newSyncCode();
  assert.match(code, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(X.parseSyncCode(code.toLowerCase().replace(/-/g, ' ')).code, code);
  assert.equal(X.parseSyncCode('1234-5678'), null);
  assert.equal(X.parseSyncCode(''), null);
  assert.notEqual(X.newSyncCode(), code);
});

test('chiavi derivate: stesse sul secondo dispositivo, dati cifrati', async () => {
  const code = X.newSyncCode();
  const a = await X.deriveKeys(code), b = await X.deriveKeys(code.toLowerCase());
  assert.equal(a.space, b.space);
  assert.equal(a.auth, b.auth);
  assert.match(a.space, /^[0-9a-f]{32}$/);
  assert.notEqual(a.space, a.auth.slice(0, 32));
  assert.equal(await X.itemId(a, 'xp.a.12345678.fav.live'), await X.itemId(b, 'xp.a.12345678.fav.live'));
  assert.notEqual(await X.itemId(a, 'k1'), await X.itemId(a, 'k2'));
  const obj = { k: 'acct:http://s|u', v: { password: 'segreta' }, t: 5 };
  const sealed = await X.seal(a, obj);
  assert.equal(sealed.includes('segreta'), false);
  assert.deepEqual(await X.open(b, sealed), obj);
  // un altro codice non apre i dati
  const other = await X.deriveKeys(X.newSyncCode());
  await assert.rejects(X.open(other, sealed));
  await assert.rejects(X.deriveKeys('nope'));
});

test('abbinamento: stessa chiave e stesse cifre di verifica sui due lati', async () => {
  const tv = await X.pairKeyPair(), pc = await X.pairKeyPair();
  const s1 = await X.pairSecret(tv.priv, pc.pub, tv.pub, pc.pub);
  const s2 = await X.pairSecret(pc.priv, tv.pub, pc.pub, tv.pub);
  assert.equal(s1.sas, s2.sas);
  assert.match(s1.sas, /^\d{3} \d{3}$/);
  const box = await X.sealWith(s2.key, { code: 'ABCD' });
  assert.deepEqual(await X.openWith(s1.key, box), { code: 'ABCD' });
  const evil = await X.pairKeyPair();
  const s3 = await X.pairSecret(tv.priv, evil.pub, tv.pub, evil.pub);
  assert.notEqual(s3.sas, s1.sas);
  await assert.rejects(X.openWith(s3.key, box));
});

test('codice di abbinamento: 8 cifre', () => {
  const c = X.newPairCode();
  assert.match(c, /^\d{8}$/);
  assert.equal(X.cleanPairCode('1234 5678'), '12345678');
  assert.equal(X.cleanPairCode('1234'), null);
  assert.equal(X.formatPairCode('12345678'), '1234 5678');
});

test('chiavi sincronizzate', () => {
  assert.ok(X.isSyncedKey('xp.a.0a1b2c3d.fav.live'));
  assert.ok(X.isSyncedKey('xp.a.0a1b2c3d.recent.series'));
  assert.ok(X.isSyncedKey('xp.a.0a1b2c3d.resume.123'));
  assert.ok(X.isSyncedKey('xp.a.0a1b2c3d.resume.ep.55'));
  assert.ok(X.isSyncedKey('xp.a.0a1b2c3d.series.last.9'));
  assert.ok(X.isSyncedKey('xp.settings'));
  assert.equal(X.isSyncedKey('xp.a.0a1b2c3d.cat.live'), false);
  assert.equal(X.isSyncedKey('xp.a.0a1b2c3d.route.4'), false);
  assert.equal(X.isSyncedKey('xp.volume'), false);
  assert.equal(X.isSyncedKey('xp.theater'), false);
  assert.ok(X.isListKey('xp.a.0a1b2c3d.fav.vod'));
  assert.equal(X.isListKey('xp.a.0a1b2c3d.resume.1'), false);
  assert.deepEqual(X.sharedSettings({ audioLang: 'ita', subLang: '', engine: 'web', quality: 'high' }), { audioLang: 'ita', subLang: '' });
});

test('conflitti: vince la modifica più recente, la prima volta le liste si uniscono', () => {
  const k = 'xp.a.0a1b2c3d.fav.live', r = 'xp.a.0a1b2c3d.resume.1';
  assert.equal(X.resolve(k, { v: [{ stream_id: 1 }], t: 0 }, { v: [], t: 10 }), 'merge');
  assert.equal(X.resolve(k, { v: null, t: 0 }, { v: [], t: 10 }), 'take');
  assert.equal(X.resolve(k, { v: [], t: 20 }, { v: [], t: 10 }), 'keep');
  assert.equal(X.resolve(k, { v: [], t: 5 }, { v: [], t: 10 }), 'take');
  assert.equal(X.resolve(r, { v: { p: 1, t: 50 }, t: 50 }, { v: { p: 9, t: 40 }, t: 40 }), 'keep');
  assert.equal(X.resolve(r, { v: { p: 1 }, t: 0 }, { v: { p: 9 }, t: 40 }), 'take');
  // cancellazione remota più recente
  assert.equal(X.resolve(k, { v: [{ stream_id: 1 }], t: 3 }, { d: true, t: 9 }), 'take');
  assert.equal(X.valueTime({ p: 3, t: 77 }), 77);
  assert.equal(X.valueTime([1]), 0);
  assert.deepEqual(X.unionList([{ stream_id: 2 }, { stream_id: 1 }], [{ stream_id: 1 }, { stream_id: 3 }]).map((i) => i.stream_id), [2, 1, 3]);
  assert.deepEqual(X.unionList([{ stream_id: 1 }], [{ stream_id: 2 }, { stream_id: 3 }], 2).map((i) => i.stream_id), [1, 2]);
});

test('voce della playlist', () => {
  assert.equal(X.accountItemKey({ server: 'http://h:80', username: 'u' }), 'acct:http://h:80|u');
  assert.ok(X.isAccountItemKey('acct:x|y'));
  assert.equal(X.isAccountItemKey('xp.settings'), false);
});

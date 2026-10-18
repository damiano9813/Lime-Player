// tauri-action scrive in latest.json gli indirizzi dell'API di GitHub (releases/assets/<id>):
// senza token hanno un limite di 60 richieste l'ora per IP e oltre rispondono 403, quindi
// l'aggiornamento fallisce. Questo script li sostituisce con i link di download diretti.
//   node scripts/fix-updater-json.mjs <latest.json> <assets.json>
// assets.json: elenco degli asset della release ({ id, browser_download_url }), da
// `gh api repos/<owner>/<repo>/releases/tags/<tag> --jq .assets`.
import { readFileSync, writeFileSync } from 'node:fs';

const [jsonPath, assetsPath] = process.argv.slice(2);
if (!jsonPath || !assetsPath) {
  console.error('uso: node scripts/fix-updater-json.mjs <latest.json> <assets.json>');
  process.exit(2);
}
const latest = JSON.parse(readFileSync(jsonPath, 'utf8'));
const assets = JSON.parse(readFileSync(assetsPath, 'utf8'));
const direct = new Map(assets.map((a) => [String(a.id), a.browser_download_url]));

for (const [platform, entry] of Object.entries(latest.platforms || {})) {
  const m = /\/releases\/assets\/(\d+)$/.exec(entry.url || '');
  if (m) {
    const url = direct.get(m[1]);
    if (!url) throw new Error(`${platform}: asset ${m[1]} non trovato nella release`);
    entry.url = url;
  }
  if (!/^https:\/\/github\.com\/.+\/releases\/download\//.test(entry.url)) {
    throw new Error(`${platform}: link inatteso ${entry.url}`);
  }
  console.log(`${platform}: ${entry.url}`);
}
writeFileSync(jsonPath, JSON.stringify(latest, null, 2) + '\n');

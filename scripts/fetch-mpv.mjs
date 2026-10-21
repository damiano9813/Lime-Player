// Scarica libmpv (build di shinchiro, versione fissata) in src-tauri/binaries/ per bundle.resources:
// è il motore di riproduzione integrato, caricato a runtime da src-tauri/src/mpv.rs. Verifica lo
// SHA-256 dell'archivio; se la DLL c'è già non fa nulla.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// le build giornaliere restano online circa due mesi: quando sparisce, si passa a una più recente
// (https://github.com/shinchiro/mpv-winbuild-cmake/releases, archivio mpv-dev-x86_64 senza -v3,
// che richiederebbe AVX2) aggiornando RELEASE, ARCHIVE e SHA256
const RELEASE = '20261018';
const ARCHIVE = 'mpv-dev-x86_64-20261018-git-01e2533f31';
const SHA256 = 'd7f5621f42b6e161fe032df914a10bdece28a89df3e57c6c3e16a5a250929b5e';
const URL = `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${RELEASE}/${ARCHIVE}.7z`;
const DLL = 'libmpv-2.dll';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src-tauri', 'binaries');
const stamp = path.join(out, 'mpv-version.txt');

function upToDate() {
  try {
    return fs.readFileSync(stamp, 'utf8').trim() === ARCHIVE && fs.statSync(path.join(out, DLL)).size > 0;
  } catch {
    return false;
  }
}

async function download(file) {
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download fallito: HTTP ${res.status} (build rimossa? vedi il commento in cima)`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let got = 0;
  let shown = -1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    hash.update(chunk);
    got += chunk.length;
    const step = total ? Math.floor((got / total) * 10) : -1;
    if (step !== shown && step >= 0) {
      shown = step;
      process.stdout.write(`  ${step * 10}% (${(got / 1048576).toFixed(0)} MB)\n`);
    }
  });
  await pipeline(body, fs.createWriteStream(file));
  return hash.digest('hex');
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('fetch-mpv: solo Windows, nulla da fare.');
    return;
  }
  if (upToDate()) {
    console.log(`fetch-mpv: ${ARCHIVE} già presente.`);
    return;
  }
  fs.mkdirSync(out, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-mpv-'));
  try {
    const archive = path.join(tmp, `${ARCHIVE}.7z`);
    console.log(`fetch-mpv: scarico ${URL}`);
    let sum = '';
    // GitHub a volte chiude la connessione a metà: qualche tentativo prima di arrendersi
    for (let attempt = 1; ; attempt++) {
      try { sum = await download(archive); break; } catch (e) {
        if (attempt >= 3) throw e;
        console.log(`fetch-mpv: tentativo ${attempt} fallito (${e.message}), riprovo`);
      }
    }
    if (sum !== SHA256) throw new Error(`SHA-256 non corrispondente: atteso ${SHA256}, ottenuto ${sum}`);
    // tar di Windows (bsdtar) legge anche i 7z; si estrae solo la DLL
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', archive, '-C', tmp, DLL], { stdio: 'inherit' });
    fs.copyFileSync(path.join(tmp, DLL), path.join(out, DLL));
    fs.writeFileSync(stamp, ARCHIVE + '\n');
    console.log(`fetch-mpv: ${DLL} in src-tauri/binaries/`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('fetch-mpv: ' + e.message);
  process.exit(1);
});

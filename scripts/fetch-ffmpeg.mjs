// Scarica ffmpeg/ffprobe (build LGPL di BtbN, versione fissata) in src-tauri/binaries/ per
// bundle.externalBin. Verifica lo SHA-256 dell'archivio; se i file ci sono già non fa nulla.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// build di fine mese: BtbN le conserva, le giornaliere vengono cancellate dopo qualche settimana
const RELEASE = 'autobuild-2026-09-30-13-08';
const ARCHIVE = 'ffmpeg-n9.0.2-17-g2a571b6068-win64-lgpl-9.0';
const SHA256 = '6b264b9e6019103f601d98c292bd332fd87acf1c5e941ddff4fb71760fe63432';
const URL = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${RELEASE}/${ARCHIVE}.zip`;
const TRIPLE = 'x86_64-pc-windows-msvc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src-tauri', 'binaries');
const stamp = path.join(out, 'ffmpeg-version.txt');
const targets = [
  [`${ARCHIVE}/bin/ffmpeg.exe`, `ffmpeg-${TRIPLE}.exe`],
  [`${ARCHIVE}/bin/ffprobe.exe`, `ffprobe-${TRIPLE}.exe`],
  [`${ARCHIVE}/LICENSE.txt`, 'ffmpeg-LICENSE.txt'],
];

function upToDate() {
  try {
    return fs.readFileSync(stamp, 'utf8').trim() === ARCHIVE
      && targets.every(([, dst]) => fs.statSync(path.join(out, dst)).size > 0);
  } catch {
    return false;
  }
}

async function download(file) {
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download fallito: HTTP ${res.status}`);
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
    console.log('fetch-ffmpeg: solo Windows, nulla da fare.');
    return;
  }
  if (upToDate()) {
    console.log(`fetch-ffmpeg: ${ARCHIVE} già presente.`);
    return;
  }
  fs.mkdirSync(out, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xp-ffmpeg-'));
  try {
    const zip = path.join(tmp, `${ARCHIVE}.zip`);
    console.log(`fetch-ffmpeg: scarico ${URL}`);
    const sum = await download(zip);
    if (sum !== SHA256) throw new Error(`SHA-256 non corrispondente: atteso ${SHA256}, ottenuto ${sum}`);
    // tar di Windows (bsdtar) legge anche gli zip; si estraggono solo i file necessari
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    execFileSync(tar, ['-xf', zip, '-C', tmp, ...targets.map(([src]) => src)], { stdio: 'inherit' });
    for (const [src, dst] of targets) fs.copyFileSync(path.join(tmp, src), path.join(out, dst));
    fs.writeFileSync(stamp, ARCHIVE + '\n');
    console.log(`fetch-ffmpeg: ${targets.map((t) => t[1]).join(', ')} in src-tauri/binaries/`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error('fetch-ffmpeg: ' + e.message);
  process.exit(1);
});

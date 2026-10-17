// Copia le librerie video (versioni fissate in package.json) in ui/vendor/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'ui', 'vendor');
fs.mkdirSync(out, { recursive: true });

fs.mkdirSync(path.join(out, 'fonts'), { recursive: true });

const files = [
  ['node_modules/mpegts.js/dist/mpegts.js', 'mpegts.min.js'],
  ['node_modules/hls.js/dist/hls.min.js', 'hls.min.js'],
  // font del design system, caricati da ui/vendor/app.css (vedi tailwind.css)
  ['node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2', 'fonts/manrope-latin-wght-normal.woff2'],
  ['node_modules/@fontsource-variable/manrope/files/manrope-latin-ext-wght-normal.woff2', 'fonts/manrope-latin-ext-wght-normal.woff2'],
  ['node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 'fonts/jetbrains-mono-latin-400-normal.woff2'],
];
for (const [src, dst] of files) {
  const from = path.join(root, src);
  if (!fs.existsSync(from)) {
    console.error(`Manca ${src}: esegui "npm install" nella cartella xtream-player.`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(out, dst));
}
console.log('vendor: ' + files.map((f) => f[1]).join(', '));

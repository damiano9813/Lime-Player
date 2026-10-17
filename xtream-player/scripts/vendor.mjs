// Copia le librerie video (versioni fissate in package.json) in ui/vendor/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'ui', 'vendor');
fs.mkdirSync(out, { recursive: true });

const files = [
  ['node_modules/mpegts.js/dist/mpegts.js', 'mpegts.min.js'],
  ['node_modules/hls.js/dist/hls.min.js', 'hls.min.js'],
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

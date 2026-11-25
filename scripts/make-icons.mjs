// Logo di Lime Player: uno spicchio di lime visto in sezione, a forma di tasto play (punta a
// destra = centro del frutto, arco a sinistra = buccia). Lo script disegna il logo in SVG e ne
// ricava tutte le immagini dell'app:
//   ui/img/logo.svg, ui/img/logo-small.svg          marchio nell'interfaccia
//   src-tauri/icons/icon.ico, icon.png              Windows (sotto i 64 px una versione semplificata)
//   gen/android/.../mipmap-*/ic_launcher*.png       icona Android (anche adattiva e monocromatica)
//   gen/android/.../drawable/ic_launcher_background.xml, drawable-xhdpi/banner.png (Android TV)
// Le immagini sono disegnate da Edge o Chrome in modalità headless (SVG e font Manrope del
// progetto), quindi non servono dipendenze in più.
//   npm run icons          (BROWSER=<percorso di chrome/msedge> per usare un browser diverso)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { constants, deflateSync, inflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'src-tauri/gen/android/app/src/main/res');

// ---------------------------------------------------------------- colori
const C = {
  tileTop: '#1a2712',
  tileBottom: '#070a06',
  glow: '#b6f03c',
  rindLight: '#63c22f',
  rindDark: '#2c8a1d',
  pith: '#f2fadf',
  fleshCore: '#f0fda0',
  fleshMid: '#c8f04a',
  fleshEdge: '#93d82a',
  lime: '#b9ee3f', // "Lime" nel banner
};

// ---------------------------------------------------------------- geometria
const r2 = (n) => +n.toFixed(2);
const P = (p) => `${r2(p[0])} ${r2(p[1])}`;
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dir = (a) => [Math.cos(a), Math.sin(a)];
const len = (a) => Math.hypot(a[0], a[1]);
// sweep-flag dell'arco da s a e attorno a c (coordinate SVG, y verso il basso)
const sweep = (c, s, e) => ((s[0] - c[0]) * (e[1] - c[1]) - (s[1] - c[1]) * (e[0] - c[0]) > 0 ? 1 : 0);
const deg = (d) => (d * Math.PI) / 180;

// Settore con la punta nell'origine tra gli angoli a0 < a1 (raggio R), angoli arrotondati:
// fo sui due spigoli della buccia, fa sulla punta.
function wedgePath(R, a0, a1, fo, fa) {
  const h = (a1 - a0) / 2;
  const u0 = dir(a0), u1 = dir(a1);
  const n0 = [-u0[1], u0[0]], n1 = [u1[1], -u1[0]]; // normali verso l'interno
  const t = Math.sqrt((R - fo) ** 2 - fo ** 2);
  const c0 = add(mul(u0, t), mul(n0, fo)), c1 = add(mul(u1, t), mul(n1, fo));
  const L0 = mul(u0, t), L1 = mul(u1, t);
  const O0 = mul(c0, R / (R - fo)), O1 = mul(c1, R / (R - fo));
  const da = fa / Math.tan(h);
  const A0 = mul(u0, da), A1 = mul(u1, da);
  const ca = mul(dir((a0 + a1) / 2), fa / Math.sin(h));
  return [
    `M${P(A0)}`, `L${P(L0)}`,
    `A${r2(fo)} ${r2(fo)} 0 0 ${sweep(c0, L0, O0)} ${P(O0)}`,
    `A${r2(R)} ${r2(R)} 0 0 1 ${P(O1)}`,
    `A${r2(fo)} ${r2(fo)} 0 0 ${sweep(c1, O1, L1)} ${P(L1)}`,
    `L${P(A1)}`,
    `A${r2(fa)} ${r2(fa)} 0 0 ${sweep(ca, A1, A0)} ${P(A0)}`, 'Z',
  ].join('');
}

// Polpa di uno spicchio (angoli b0..b1, raggio rf) rientrata di m0/m1 dai lati: il contorno
// ristretto di (m + rho), poi tracciato con un tratto tondo largo 2*rho, dà angoli arrotondati.
function segmentPath(rf, b0, b1, m0, m1, rho) {
  const u0 = dir(b0), u1 = dir(b1);
  const n0 = [-u0[1], u0[0]], n1 = [u1[1], -u1[0]];
  const d0 = m0 + rho, d1 = m1 + rho, r = rf - rho;
  // vertice: n0·p = d0, n1·p = d1
  const det = n0[0] * n1[1] - n0[1] * n1[0];
  const V = [(d0 * n1[1] - d1 * n0[1]) / det, (n0[0] * d1 - n1[0] * d0) / det];
  const E0 = add(mul(u0, Math.sqrt(r * r - d0 * d0)), mul(n0, d0));
  const E1 = add(mul(u1, Math.sqrt(r * r - d1 * d1)), mul(n1, d1));
  return `M${P(V)}L${P(E0)}A${r2(r)} ${r2(r)} 0 0 1 ${P(E1)}Z`;
}

// Lo spicchio in coordinate locali (punta nell'origine, rivolto a destra).
// detail: 'full' (buccia, albedo, tre spicchi), 'simple' (buccia e polpa), 'mono' (sagoma bianca)
function glyph(id, R, detail) {
  const H = deg(30), a0 = Math.PI - H, a1 = Math.PI + H;
  const wedge = wedgePath(R, a0, a1, 0.07 * R, 0.075 * R);
  const rind = (detail === 'simple' ? 0.12 : 0.085) * R;
  const pith = 0.04 * R;
  const rf = R - rind - pith; // raggio esterno della polpa
  const g = 0.028 * R; // membrana tra gli spicchi
  const edge = 0.03 * R; // albedo lungo i lati tagliati
  const rho = 0.04 * R;
  const segs = [];
  for (let i = 0; i < 3; i++) {
    const b0 = a0 + ((a1 - a0) * i) / 3, b1 = a0 + ((a1 - a0) * (i + 1)) / 3;
    segs.push(segmentPath(rf, b0, b1, i === 0 ? edge : g / 2, i === 2 ? edge : g / 2, rho));
  }
  const big = 1.2 * R;
  const defs = `
    <clipPath id="${id}-w"><path d="${wedge}"/></clipPath>
    <linearGradient id="${id}-rind" gradientUnits="userSpaceOnUse" x1="${r2(-R)}" y1="${r2(-R / 2)}" x2="0" y2="${r2(R / 2)}">
      <stop offset="0" stop-color="${C.rindLight}"/><stop offset="1" stop-color="${C.rindDark}"/></linearGradient>
    <radialGradient id="${id}-flesh" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${r2(R)}">
      <stop offset="0.12" stop-color="${C.fleshCore}"/><stop offset="0.55" stop-color="${C.fleshMid}"/><stop offset="1" stop-color="${C.fleshEdge}"/></radialGradient>
    <filter id="${id}-sh" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${r2(0.03 * R)}" stdDeviation="${r2(0.04 * R)}" flood-color="#000" flood-opacity="0.45"/></filter>`;
  const band = (fill) =>
    `<circle r="${r2(R)}" fill="none" stroke="${fill}" stroke-width="${r2(2 * rind)}"/>`;
  const flesh = (fill) =>
    `<g fill="${fill}" stroke="${fill}" stroke-width="${r2(2 * rho)}" stroke-linejoin="round">${segs
      .map((d) => `<path d="${d}"/>`)
      .join('')}</g>`;
  let body;
  if (detail === 'mono') {
    // sagoma piena (la punta resta riconoscibile come tasto play) con membrane e albedo scavati
    const lines = [1, 2].map((i) => {
      const a = a0 + ((a1 - a0) * i) / 3;
      return `<path d="M${P(mul(dir(a), 0.3 * R))}L${P(mul(dir(a), rf))}"/>`;
    }).join('');
    body = `<mask id="${id}-m"><rect x="${-big}" y="${-big}" width="${2 * big}" height="${2 * big}" fill="#fff"/>
      <circle r="${r2(R - rind - pith / 2)}" fill="none" stroke="#000" stroke-width="${r2(pith * 1.2)}"/>
      <g stroke="#000" stroke-width="${r2(g * 1.3)}" stroke-linecap="round">${lines}</g></mask>
      <g clip-path="url(#${id}-w)"><rect x="${-big}" y="${-big}" width="${2 * big}" height="${2 * big}" fill="#fff" mask="url(#${id}-m)"/></g>`;
  } else if (detail === 'simple') {
    body = `<g filter="url(#${id}-sh)"><g clip-path="url(#${id}-w)">
      <rect x="${-big}" y="${-big}" width="${2 * big}" height="${2 * big}" fill="url(#${id}-flesh)"/>${band(`url(#${id}-rind)`)}</g></g>`;
  } else {
    body = `<g filter="url(#${id}-sh)"><g clip-path="url(#${id}-w)">
      <rect x="${-big}" y="${-big}" width="${2 * big}" height="${2 * big}" fill="${C.pith}"/>${band(`url(#${id}-rind)`)}${flesh(`url(#${id}-flesh)`)}</g></g>`;
  }
  return { defs, body };
}

// punta spostata a destra: il baricentro dello spicchio cade al centro
const tipX = (cx, R) => cx + 0.58 * R;

// Icona completa: piastrella scura (quadrata arrotondata o tonda) con lo spicchio.
function tileSvg({ detail = 'full', shape = 'square', size = 1024 } = {}) {
  const S = 1024, c = S / 2;
  const inset = shape === 'round' ? 40 : 48;
  const w = S - 2 * inset;
  const R = detail === 'simple' ? 0.62 * w : 0.58 * w;
  const tx = tipX(c, R);
  const g = glyph('g', R, detail);
  const tile = (attrs) =>
    shape === 'round'
      ? `<circle cx="${c}" cy="${c}" r="${w / 2}" ${attrs}/>`
      : `<rect x="${inset}" y="${inset}" width="${w}" height="${w}" rx="${0.225 * w}" ${attrs}/>`;
  const rim = shape === 'round'
    ? `<circle cx="${c}" cy="${c}" r="${w / 2 - 3}" fill="none" stroke="#fff" stroke-opacity="0.08" stroke-width="6"/>`
    : `<rect x="${inset + 3}" y="${inset + 3}" width="${w - 6}" height="${w - 6}" rx="${0.225 * w - 3}" fill="none" stroke="#fff" stroke-opacity="0.08" stroke-width="6"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${size}" height="${size}">
  <defs>
    <linearGradient id="t-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.tileTop}"/><stop offset="1" stop-color="${C.tileBottom}"/></linearGradient>
    <radialGradient id="t-glow" gradientUnits="userSpaceOnUse" cx="${r2(tx - 0.62 * R)}" cy="${c}" r="${r2(0.95 * R)}">
      <stop offset="0" stop-color="${C.glow}" stop-opacity="0.26"/><stop offset="1" stop-color="${C.glow}" stop-opacity="0"/></radialGradient>${g.defs}
  </defs>
  ${tile('fill="url(#t-bg)"')}
  ${tile('fill="url(#t-glow)"')}
  ${rim}
  <g transform="translate(${r2(tx)} ${c})">${g.body}</g>
</svg>`;
}

// Primo piano dell'icona adattiva Android: tela di 108 dp, spicchio dentro il cerchio sicuro di 66 dp.
function foregroundSvg(detail, size) {
  const S = 108, c = 54, R = 44;
  const tx = tipX(c, R);
  const g = glyph('f', R, detail);
  const glow = detail === 'mono' ? '' : `<circle cx="${r2(tx - 0.62 * R)}" cy="${c}" r="${r2(0.95 * R)}" fill="url(#f-glow)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${size}" height="${size}">
  <defs><radialGradient id="f-glow"><stop offset="0" stop-color="${C.glow}" stop-opacity="0.24"/><stop offset="1" stop-color="${C.glow}" stop-opacity="0"/></radialGradient>${g.defs}</defs>
  ${glow}<g transform="translate(${r2(tx)} ${c})">${g.body}</g>
</svg>`;
}

const androidBackgroundXml = `<?xml version="1.0" encoding="utf-8"?>
<!-- generato da scripts/make-icons.mjs: sfondo dell'icona adattiva (stesso gradiente della piastrella) -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="54"
                android:startY="0"
                android:endX="54"
                android:endY="108"
                android:startColor="#FF${C.tileTop.slice(1).toUpperCase()}"
                android:endColor="#FF${C.tileBottom.slice(1).toUpperCase()}" />
        </aapt:attr>
    </path>
</vector>
`;

// ---------------------------------------------------------------- PNG
// Il canvas salva i PNG con una compressione veloce: si ricomprimono senza perdita (filtro scelto
// riga per riga e deflate al massimo), circa la metà del peso. Solo RGBA a 8 bit, come dal canvas.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  let c = 0xffffffff;
  for (const b of [...head.subarray(4), ...data]) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, data, tail]);
}
function optimizePng(buf) {
  let ihdr;
  const idat = [];
  for (let pos = 8; pos < buf.length;) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') ihdr = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    pos += 12 + len;
  }
  if (!ihdr || ihdr[8] !== 8 || ihdr[9] !== 6 || ihdr[12] !== 0) return buf;
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4), bpp = 4, stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  const pred = (f, a, b, c) => (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0, b = y ? px[row - stride + x] : 0;
      const c = x >= bpp && y ? px[row - stride + x - bpp] : 0;
      px[row + x] = (raw[src + x] + pred(f, a, b, c)) & 255;
    }
  }
  const out = Buffer.alloc(h * (stride + 1)), tmp = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    let best = Infinity;
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[row + x - bpp] : 0, b = y ? px[row - stride + x] : 0;
        const c = x >= bpp && y ? px[row - stride + x - bpp] : 0;
        const v = (px[row + x] - pred(f, a, b, c)) & 255;
        tmp[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < best) {
        best = score;
        out[y * (stride + 1)] = f;
        tmp.copy(out, y * (stride + 1) + 1);
      }
    }
  }
  const z = [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]
    .map((strategy) => deflateSync(out, { level: 9, memLevel: 9, strategy }))
    .reduce((x, y) => (y.length < x.length ? y : x));
  const res = Buffer.concat([buf.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', Buffer.alloc(0))]);
  return res.length < buf.length ? res : buf;
}

// ---------------------------------------------------------------- rendering
const DENSITIES = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const jobs = []; // { name, svg, w, h } oppure { name, banner: true, w, h }
for (const s of ICO_SIZES) jobs.push({ name: `ico-${s}`, svg: tileSvg({ detail: s < 64 ? 'simple' : 'full', size: s }), w: s, h: s });
jobs.push({ name: 'icon.png', svg: tileSvg({ size: 512 }), w: 512, h: 512 });
for (const [d, k] of DENSITIES) {
  const l = 48 * k, f = 108 * k;
  const det = l < 96 ? 'simple' : 'full';
  jobs.push({ name: `mipmap-${d}/ic_launcher.png`, svg: tileSvg({ detail: det, size: l }), w: l, h: l });
  jobs.push({ name: `mipmap-${d}/ic_launcher_round.png`, svg: tileSvg({ detail: det, shape: 'round', size: l }), w: l, h: l });
  jobs.push({ name: `mipmap-${d}/ic_launcher_foreground.png`, svg: foregroundSvg(f < 216 ? 'simple' : 'full', f), w: f, h: f });
  jobs.push({ name: `mipmap-${d}/ic_launcher_monochrome.png`, svg: foregroundSvg('mono', f), w: f, h: f });
}
jobs.push({ name: 'banner-tile', svg: tileSvg({ size: 232 }), w: 232, h: 232, hidden: true });
jobs.push({ name: 'drawable-xhdpi/banner.png', banner: true, w: 640, h: 360 });

const font = readFileSync(join(ROOT, 'node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2')).toString('base64');

const page = `<!doctype html><meta charset="utf-8"><body><pre id="out"></pre><script>
const jobs = ${JSON.stringify(jobs)};
const C = ${JSON.stringify(C)};
const load = (svg) => new Promise((ok, ko) => {
  const img = new Image();
  img.onload = () => ok(img); img.onerror = ko;
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
});
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
(async () => {
  const out = {};
  try {
    const font = new FontFace('Manrope', 'url(data:font/woff2;base64,${font})', { weight: '200 800' });
    await font.load(); document.fonts.add(font);
    const imgs = {};
    for (const j of jobs) {
      if (j.banner) continue;
      const img = imgs[j.name] = await load(j.svg);
      const c = canvas(j.w, j.h);
      c.getContext('2d').drawImage(img, 0, 0, j.w, j.h);
      if (!j.hidden) out[j.name] = c.toDataURL('image/png');
      imgs[j.name] = c;
    }
    // banner Android TV (320x180 dp in xhdpi): icona a sinistra, "Lime" e "Player" su due righe
    const b = jobs.find((j) => j.banner);
    const c = canvas(b.w, b.h), x = c.getContext('2d');
    const bg = x.createLinearGradient(0, 0, 0, b.h);
    bg.addColorStop(0, '#111a0d'); bg.addColorStop(1, '#050704');
    x.fillStyle = bg; x.fillRect(0, 0, b.w, b.h);
    const glow = x.createRadialGradient(170, 180, 0, 170, 180, 260);
    glow.addColorStop(0, 'rgba(182,240,60,0.16)'); glow.addColorStop(1, 'rgba(182,240,60,0)');
    x.fillStyle = glow; x.fillRect(0, 0, b.w, b.h);
    const tile = imgs['banner-tile'];
    x.drawImage(tile, 52, (b.h - tile.height) / 2);
    x.font = '800 92px Manrope'; x.letterSpacing = '-2px'; x.textBaseline = 'alphabetic';
    const tx = 52 + tile.width + 30;
    x.fillStyle = C.lime; x.fillText('Lime', tx, 166);
    x.fillStyle = '#ffffff'; x.fillText('Player', tx, 262);
    out[b.name] = c.toDataURL('image/png');
  } catch (e) { out.error = String(e && e.stack || e); }
  document.getElementById('out').textContent = JSON.stringify(out);
})();
</script>`;

function findBrowser() {
  const cands = [
    process.env.BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const b = cands.find((p) => p && existsSync(p));
  if (!b) throw new Error('Serve Edge o Chrome: impostare BROWSER con il percorso del browser');
  return b;
}

const tmp = mkdtempSync(join(tmpdir(), 'lime-icons-'));
try {
  const html = join(tmp, 'render.html');
  writeFileSync(html, page);
  const r = spawnSync(findBrowser(), [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${join(tmp, 'profile')}`, '--virtual-time-budget=30000', '--dump-dom', pathToFileURL(html).href,
  ], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(r.stdout || '');
  if (!m || !m[1]) throw new Error(`rendering non riuscito (codice ${r.status}): ${(r.stderr || '').slice(0, 2000)}`);
  const out = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  if (out.error) throw new Error(out.error);
  const png = (name) => optimizePng(Buffer.from(out[name].split(',')[1], 'base64'));
  const put = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data); console.log('  ' + file.slice(ROOT.length + 1)); };

  // SVG per l'interfaccia (dimensione libera)
  put(join(ROOT, 'ui/img/logo.svg'), tileSvg({ size: 1024 }).replace(/ width="1024" height="1024"/, '') + '\n');
  put(join(ROOT, 'ui/img/logo-small.svg'), tileSvg({ detail: 'simple', size: 1024 }).replace(/ width="1024" height="1024"/, '') + '\n');

  // Windows: .ico con un PNG per dimensione
  const entries = ICO_SIZES.map((s) => ({ s, data: png(`ico-${s}`) }));
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let off = head.length;
  entries.forEach(({ s, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(off, e + 12);
    off += data.length;
  });
  put(join(ROOT, 'src-tauri/icons/icon.ico'), Buffer.concat([head, ...entries.map((e) => e.data)]));
  put(join(ROOT, 'src-tauri/icons/icon.png'), png('icon.png'));

  // Android
  for (const j of jobs) {
    if (j.hidden || j.name.startsWith('ico-') || j.name === 'icon.png') continue;
    put(join(RES, j.name), png(j.name));
  }
  put(join(RES, 'drawable/ic_launcher_background.xml'), androidBackgroundXml);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

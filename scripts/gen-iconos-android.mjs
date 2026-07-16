// Genera los íconos y pantallas de arranque del APK Android
// (android/app/src/main/res/) con el mismo dibujo de scripts/gen-iconos.mjs:
// ruta punteada, punto de salida verde y pin rojo sobre fondo azul.
// Correr: node scripts/gen-iconos-android.mjs  (tras `npx cap add android`)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------- codificador PNG mínimo (RGBA, sin filtros) ----------------------
const TABLA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABLA_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(tipo, datos) {
  const t = Buffer.from(tipo, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(datos.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, datos])));
  return Buffer.concat([len, t, datos, crc]);
}

function pngDesdeRGBA(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  const crudo = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    crudo[y * (w * 4 + 1)] = 0; // filtro 0
    rgba.copy(crudo, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(crudo, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- geometría --------------------------------------------------------
const dist = (x, y, a, b) => Math.hypot(x - a, y - b);

function distSegmento(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((x - x1) * dx + (y - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = x1 + t * dx, py = y1 + t * dy;
  return { d: Math.hypot(x - px, y - py), a: t * Math.sqrt(l2) };
}

function dentroTriangulo(px, py, a, b, c) {
  const s = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = s([px, py], a, b), d2 = s([px, py], b, c), d3 = s([px, py], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// ---------- dibujo del arte (en lienzo lógico de 512) ------------------------
const AZUL = [29, 53, 87], BLANCO = [255, 255, 255];
const VERDE = [42, 157, 58], ROJO = [230, 57, 70];

const RUTA = [
  [110, 400], [110, 250], [260, 250], [260, 140], [395, 140]
];
const GUION = 40, HUECO = 28, GROSOR = 13;

const LARGOS = (() => {
  let acumulado = 0;
  const l = [];
  for (let i = 1; i < RUTA.length; i++) {
    l.push(acumulado);
    acumulado += Math.hypot(RUTA[i][0] - RUTA[i - 1][0], RUTA[i][1] - RUTA[i - 1][1]);
  }
  return l;
})();

// color del arte en el punto (cx, cy) de coordenadas 512, o null si no toca nada
function colorArte(cx, cy) {
  let col = null;

  for (let i = 1; i < RUTA.length; i++) {
    const { d, a } = distSegmento(
      cx, cy, RUTA[i - 1][0], RUTA[i - 1][1], RUTA[i][0], RUTA[i][1]
    );
    if (d <= GROSOR && (LARGOS[i - 1] + a) % (GUION + HUECO) < GUION) {
      col = BLANCO;
      break;
    }
  }

  const dSalida = dist(cx, cy, 110, 400);
  if (dSalida <= 43) col = dSalida >= 33 ? BLANCO : VERDE;

  const enCabeza = dist(cx, cy, 395, 118) <= 52;
  const enPunta = dentroTriangulo(cx, cy, [350, 142], [440, 142], [395, 204]);
  if (enCabeza || enPunta) {
    col = dist(cx, cy, 395, 116) <= 22 ? BLANCO : ROJO;
  }

  return col;
}

// lienzo w x h: fondo (null = transparente) + arte centrado ocupando `escala`
// veces la dimensión menor
function lienzo(w, h, fondo, escala, mascara) {
  const rgba = Buffer.alloc(w * h * 4);
  const lado = Math.min(w, h) * escala; // tamaño del arte en píxeles
  const x0 = (w - lado) / 2, y0 = (h - lado) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (mascara && !mascara(x + 0.5, y + 0.5)) continue; // transparente
      let col = fondo;
      const cx = ((x + 0.5) - x0) / lado * 512;
      const cy = ((y + 0.5) - y0) / lado * 512;
      if (cx >= 0 && cx < 512 && cy >= 0 && cy < 512) {
        const arte = colorArte(cx, cy);
        if (arte) col = arte;
      }
      if (!col) continue; // transparente
      rgba[i] = col[0];
      rgba[i + 1] = col[1];
      rgba[i + 2] = col[2];
      rgba[i + 3] = 255;
    }
  }
  return pngDesdeRGBA(w, h, rgba);
}

// ---------- salidas ----------------------------------------------------------
const RES = path.join('android', 'app', 'src', 'main', 'res');
if (!fs.existsSync(RES)) {
  console.error('No existe android/app/src/main/res — correr antes `npx cap add android`.');
  process.exit(1);
}

const escribir = (rel, buf) => {
  fs.writeFileSync(path.join(RES, rel), buf);
  console.log('  ' + rel);
};

// esquina redondeada (radio 90/512 del lado) para el ícono clásico
const mascaraRedondeada = (n) => (x, y) => {
  const r = (90 / 512) * n;
  const rx = Math.max(r - x, x - (n - r), 0);
  const ry = Math.max(r - y, y - (n - r), 0);
  return !(rx > 0 && ry > 0 && Math.hypot(rx, ry) > r);
};
const mascaraCircular = (n) => (x, y) =>
  Math.hypot(x - n / 2, y - n / 2) <= n / 2;

const DENSIDADES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

console.log('Íconos del lanzador:');
for (const [dpi, k] of Object.entries(DENSIDADES)) {
  const n = 48 * k;   // ícono clásico
  const f = 108 * k;  // capa frontal del ícono adaptativo (arte en zona segura)
  escribir(`mipmap-${dpi}/ic_launcher.png`, lienzo(n, n, AZUL, 1, mascaraRedondeada(n)));
  escribir(`mipmap-${dpi}/ic_launcher_round.png`, lienzo(n, n, AZUL, 1, mascaraCircular(n)));
  escribir(`mipmap-${dpi}/ic_launcher_foreground.png`, lienzo(f, f, null, 0.5));
}

console.log('Pantallas de arranque:');
const SPLASH = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
for (const [dpi, [a, b]] of Object.entries(SPLASH)) {
  escribir(`drawable-port-${dpi}/splash.png`, lienzo(a, b, AZUL, 0.45));
  escribir(`drawable-land-${dpi}/splash.png`, lienzo(b, a, AZUL, 0.45));
}
escribir('drawable/splash.png', lienzo(480, 320, AZUL, 0.45));

// fondo del ícono adaptativo: azul en lugar del blanco por defecto
const fondoXml = path.join(RES, 'values', 'ic_launcher_background.xml');
fs.writeFileSync(fondoXml, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#1D3557</color>
</resources>`);
console.log('  values/ic_launcher_background.xml (fondo azul)');

console.log('Listo.');

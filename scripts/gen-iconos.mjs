// Genera los íconos PNG de la PWA (public/icono-192.png y icono-512.png)
// sin dependencias: rasteriza el dibujo píxel por píxel y codifica el PNG
// con zlib de Node. Correr: node scripts/gen-iconos.mjs

import fs from 'node:fs';
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

// distancia de un punto a un segmento + posición a lo largo (para los guiones)
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

// ---------- dibujo del ícono -------------------------------------------------
function dibujar(n) {
  const u = n / 512;
  const rgba = Buffer.alloc(n * n * 4);

  const AZUL = [29, 53, 87], BLANCO = [255, 255, 255];
  const VERDE = [42, 157, 58], ROJO = [230, 57, 70];

  // ruta en zigzag (coordenadas en lienzo de 512)
  const ruta = [
    [110, 400], [110, 250], [260, 250], [260, 140], [395, 140]
  ];
  const GUION = 40, HUECO = 28, GROSOR = 13; // mitad del ancho de línea 26

  const radioEsq = 90 * u;
  let acumulado = 0;
  const largos = [];
  for (let i = 1; i < ruta.length; i++) {
    const L = Math.hypot(ruta[i][0] - ruta[i - 1][0], ruta[i][1] - ruta[i - 1][1]);
    largos.push(acumulado);
    acumulado += L;
  }

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const cx = (x + 0.5) / u; // a coordenadas de 512
      const cy = (y + 0.5) / u;

      // fondo redondeado
      const rx = Math.max(90 - cx, cx - (512 - 90), 0);
      const ry = Math.max(90 - cy, cy - (512 - 90), 0);
      const fueraEsquina = rx > 0 && ry > 0 && Math.hypot(rx, ry) > 90;
      if (fueraEsquina) continue; // transparente

      let col = AZUL;

      // ruta punteada blanca
      for (let i = 1; i < ruta.length; i++) {
        const { d, a } = distSegmento(
          cx, cy, ruta[i - 1][0], ruta[i - 1][1], ruta[i][0], ruta[i][1]
        );
        if (d <= GROSOR && (largos[i - 1] + a) % (GUION + HUECO) < GUION) {
          col = BLANCO;
          break;
        }
      }

      // punto de salida (verde con aro blanco)
      const dSalida = dist(cx, cy, 110, 400);
      if (dSalida <= 43) col = dSalida >= 33 ? BLANCO : VERDE;

      // pin de destino (rojo con centro blanco)
      const enCabeza = dist(cx, cy, 395, 118) <= 52;
      const enPunta = dentroTriangulo(cx, cy, [350, 142], [440, 142], [395, 204]);
      if (enCabeza || enPunta) {
        col = dist(cx, cy, 395, 116) <= 22 ? BLANCO : ROJO;
      }

      const i = (y * n + x) * 4;
      rgba[i] = col[0];
      rgba[i + 1] = col[1];
      rgba[i + 2] = col[2];
      rgba[i + 3] = 255;
    }
  }
  return pngDesdeRGBA(n, n, rgba);
}

fs.writeFileSync('public/icono-192.png', dibujar(192));
fs.writeFileSync('public/icono-512.png', dibujar(512));
console.log('Íconos generados en public/.');

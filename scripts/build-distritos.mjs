// Arma public/distritos_morelia.json: los límites OFICIALES de los distritos
// electorales LOCALES que cubren el municipio de Morelia (incluidas sus
// tenencias, que son parte del municipio).
//
// Ojo con el tipo de distrito: la base del INE trae DOS capas que se parecen,
// DISTRITO_FEDERAL y DISTRITO_LOCAL, con numeraciones distintas. Aquí se usa
// la LOCAL, que es la que ocupan las brigadas. Como salvaguarda, el script se
// detiene si los distritos que salen no son exactamente los esperados.
//
// De dónde sale el archivo (corte diciembre 2025):
//   https://cartografia.ine.mx/sige8/productosCartograficos/bases
//   Producto "BGD - BASE GEOGRÁFICA DIGITAL", entidad Michoacán, Shapefile.
//   Se baja un .7z de ~58 MB por estado.
//
// Uso:
//   node scripts/build-distritos.mjs "C:/ruta/16 MICHOACAN DE OCAMPO.7z" [--dry]
//
// Requiere: npm i -D shapefile proj4 @turf/turf 7zip-min

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unpackSome } from '7zip-min';
import * as shapefile from 'shapefile';
import proj4 from 'proj4';
import * as turf from '@turf/turf';
import { simplifyRing } from '../src/lib/geo.js';

const archivo = process.argv[2];
const soloRevisar = process.argv.includes('--dry');
if (!archivo) {
  console.error('Falta el archivo. Uso: node scripts/build-distritos.mjs "<ruta al .7z del INE>" [--dry]');
  process.exit(1);
}

const SALIDA = 'public/distritos_morelia.json';
// Los que debe cubrir Morelia. Si sale cualquier otro, algo se agarró mal
// (típicamente la capa federal en vez de la local) y mejor detenerse.
const ESPERADOS = [10, 11, 16, 17];
// Un distrito puede rozar el municipio por unos metros de error de trazo; solo
// cuentan los que de verdad tienen territorio dentro.
const MIN_KM2_DENTRO = 0.5;

const UTM14N = '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs';

// --- 1) sacar del .7z solo las dos capas que hacen falta --------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'geobrigada-ine-'));
console.log('Extrayendo las capas necesarias…');
const quiero = [];
for (const capa of ['DISTRITO_LOCAL', 'MUNICIPIO']) {
  for (const ext of ['shp', 'dbf', 'shx', 'prj']) quiero.push('*' + capa + '.' + ext);
}
await unpackSome(archivo, quiero, tmp);

// El .7z trae todo dentro de una carpeta con el nombre del estado.
function buscarCarpeta(dir) {
  if (fs.existsSync(path.join(dir, 'DISTRITO_LOCAL.shp'))) return dir;
  for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const hallado = buscarCarpeta(path.join(dir, sub.name));
    if (hallado) return hallado;
  }
  return null;
}
const dir = buscarCarpeta(tmp);
if (!dir) {
  console.error('No se encontró DISTRITO_LOCAL.shp dentro del archivo. ¿Es la Base Geográfica Digital del INE?');
  process.exit(1);
}

async function leerCapa(nombre) {
  const src = await shapefile.open(path.join(dir, nombre + '.shp'), path.join(dir, nombre + '.dbf'));
  const out = [];
  let r = await src.read();
  while (!r.done) {
    out.push(r.value);
    r = await src.read();
  }
  return out;
}

const distritos = await leerCapa('DISTRITO_LOCAL');
const municipios = await leerCapa('MUNICIPIO');
console.log(`Distritos locales en Michoacán: ${distritos.length} · municipios: ${municipios.length}`);

// --- 2) Morelia, y qué distritos lo cubren ---------------------------------
const morelia = municipios.find((m) => /^MORELIA$/i.test(String(m.properties.nombre).trim()));
if (!morelia) {
  console.error('No se encontró el municipio de Morelia en la capa MUNICIPIO.');
  process.exit(1);
}
console.log(`Municipio: ${morelia.properties.nombre} (clave ${morelia.properties.municipio})`);

// El recorte se hace en UTM (metros), que es como viene: así el área sale en
// unidades reales sin pelear con la curvatura.
const pedazos = [];
for (const d of distritos) {
  const num = Number(d.properties.distrito_l);
  let recorte = null;
  try {
    recorte = turf.intersect(turf.featureCollection([turf.feature(d.geometry), turf.feature(morelia.geometry)]));
  } catch {
    continue; // geometrías que no se pueden cruzar: no tocan Morelia
  }
  if (!recorte) continue;
  // turf.area asume grados; aquí son metros, así que se mide a mano.
  const km2 = areaPlanaKm2(recorte.geometry);
  if (km2 < MIN_KM2_DENTRO) continue;
  pedazos.push({ distrito: num, km2, geom: recorte.geometry });
}
pedazos.sort((a, b) => a.distrito - b.distrito);

console.log('\n=== Distritos LOCALES con territorio en Morelia ===');
for (const p of pedazos) {
  console.log(`  Distrito ${String(p.distrito).padStart(2)} · ${p.km2.toFixed(1)} km² dentro del municipio`);
}

// --- 3) la salvaguarda: que sean los que deben ser -------------------------
const salieron = pedazos.map((p) => p.distrito);
const faltan = ESPERADOS.filter((e) => !salieron.includes(e));
const sobran = salieron.filter((s) => !ESPERADOS.includes(s));
if (faltan.length || sobran.length) {
  console.error('\n❌ Los distritos no son los esperados (' + ESPERADOS.join(', ') + ').');
  if (faltan.length) console.error('   Faltan: ' + faltan.join(', '));
  if (sobran.length) console.error('   Sobran: ' + sobran.join(', '));
  console.error('   Probablemente se leyó la capa equivocada (¿federal en vez de local?)');
  console.error('   o cambió la distritación. No se escribió nada.');
  process.exit(1);
}
console.log('\n✅ Son exactamente los esperados: ' + ESPERADOS.join(', '));

// --- 4) a lat/lng, simplificado ---------------------------------------------
const aLatLng = ([x, y]) => {
  const [lng, lat] = proj4(UTM14N, 'WGS84', [x, y]);
  return [lat, lng]; // la app maneja [lat, lng]
};

// Anillos de un polígono/multipolígono, ya en lat/lng y aligerados. Solo se
// guardan los anillos exteriores: los huecos no existen dentro de un distrito.
function anillosDe(geom) {
  const crudos =
    geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map((p) => p[0]);
  return crudos
    .map((anillo) => simplifyRing(anillo.map(aLatLng), 15))
    .filter((a) => a.length >= 4);
}

const zonas = pedazos.map((p) => ({
  d: p.distrito,
  km2: +p.km2.toFixed(1),
  rings: anillosDe(p.geom)
}));

if (soloRevisar) {
  const puntos = zonas.reduce((s, z) => s + z.rings.reduce((t, r) => t + r.length, 0), 0);
  console.log(`\n(--dry) No se escribió nada. Serían ${zonas.length} distritos y ${puntos} puntos.`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

fs.mkdirSync('public', { recursive: true });
fs.writeFileSync(
  SALIDA,
  JSON.stringify({
    generado: new Date().toISOString().slice(0, 10),
    fuente: 'INE · Base Geográfica Digital, corte diciembre 2025',
    municipio: 'Morelia',
    distritos: zonas
  })
);
const kb = Math.round(fs.statSync(SALIDA).size / 1024);
console.log(`\nArchivo: ${SALIDA} (${kb} KB)`);
console.log('Acuérdate de subir la versión del caché en public/sw.js.');
fs.rmSync(tmp, { recursive: true, force: true });

// --- utilidades -------------------------------------------------------------
// Área de un polígono ya proyectado en metros (fórmula del zapatero).
function areaPlanaKm2(geom) {
  const anillos =
    geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flatMap((p) => p);
  let total = 0;
  for (const anillo of anillos) {
    let s = 0;
    for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
      s += anillo[j][0] * anillo[i][1] - anillo[i][0] * anillo[j][1];
    }
    total += Math.abs(s / 2);
  }
  return total / 1e6;
}

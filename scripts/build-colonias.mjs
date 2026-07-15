// Genera public/colonias_morelia.json con los límites OFICIALES de colonias
// del programa DCAH de INEGI (delimitados por el IMPLAN de Morelia).
//
// Fuente: INEGI, Delimitación de Colonias y otros Asentamientos Humanos 2024
// (archivo nacional; la edición 2024 trae 926 asentamientos para Morelia
// contra 715 de la 2023). https://www.inegi.org.mx/programas/dcah/
//
// Se corre una sola vez (o cuando INEGI publique una actualización):
//   node scripts/build-colonias.mjs

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import shapefile from 'shapefile';
import proj4 from 'proj4';
import { simplifyRing } from '../src/lib/geo.js';

const TEMP = process.env.TEMP || '/tmp';
const ZIP_URL =
  'https://www.inegi.org.mx/contenidos/productos/prod_serv/contenidos/espanol/bvinegi/productos/geografia/delimitaciones/794551132180_s.zip';
const ZIP = path.join(TEMP, 'dcah2024.zip');
const DIR = path.join(TEMP, 'dcah2024');
const SHP = path.join(DIR, 'conjunto_de_datos', '00as.shp');
const DBF = path.join(DIR, 'conjunto_de_datos', '00as.dbf');

// Proyección de INEGI (del archivo .prj) → coordenadas GPS (WGS84)
const LCC_INEGI =
  '+proj=lcc +lat_1=17.5 +lat_2=29.5 +lat_0=12 +lon_0=-102 +x_0=2500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const aWGS84 = proj4(LCC_INEGI, 'WGS84');

// Descarga y descomprime el shapefile si no está en TEMP.
if (!fs.existsSync(SHP)) {
  if (!fs.existsSync(ZIP)) {
    console.log('Descargando DCAH Michoacán de INEGI (29 MB)…');
    const res = await fetch(ZIP_URL, { headers: { 'User-Agent': 'GeoBrigada/0.1' } });
    if (!res.ok) throw new Error('Error ' + res.status + ' al descargar el DCAH');
    fs.writeFileSync(ZIP, Buffer.from(await res.arrayBuffer()));
  }
  console.log('Descomprimiendo…');
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${ZIP}' -DestinationPath '${DIR}' -Force"`
  );
}

// Pone "VILLAS DEL PEDREGAL" como "Villas del Pedregal".
const MINUSCULAS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'en', 'con']);
function titulo(s) {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i > 0 && MINUSCULAS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// El .cpg de INEGI indica ISO-8859-1 (Latin-1); leerlo como UTF-8 rompe acentos y ñ.
const src = await shapefile.open(SHP, DBF, { encoding: 'latin1' });
const colonias = [];
const polys = {};
let descartadas = 0;

while (true) {
  const r = await src.read();
  if (r.done) break;
  const p = r.value.properties;
  if (p.CVE_ENT !== '16' || p.CVE_MUN !== '053') continue; // solo Morelia, Michoacán
  // Zonas delimitadas por el IMPLAN pero SIN nombre oficial (NOM_ASEN =
  // "NINGUNO"): son ~211 espacios urbanos reales (con calles y casas) que
  // antes se descartaban. Se incluyen con un nombre generado para poderlas
  // buscar, repartir y planear como cualquier colonia.
  const sinNombre = !p.NOM_ASEN || p.NOM_ASEN === 'NINGUNO';

  const g = r.value.geometry;
  const partes =
    g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  const rings = [];
  for (const parte of partes) {
    // anillo exterior, reproyectado a [lat,lng]
    const anillo = parte[0].map(([x, y]) => {
      const [lon, lat] = aWGS84.forward([x, y]);
      return [lat, lon];
    });
    const simple = simplifyRing(anillo, 6).map(([lat, lon]) => [
      Math.round(lat * 1e5) / 1e5,
      Math.round(lon * 1e5) / 1e5
    ]);
    if (simple.length >= 3) rings.push(simple);
  }
  if (rings.length === 0) {
    descartadas++;
    continue;
  }

  const k = p.CVEGEO;
  const nombre = sinNombre
    ? 'Zona ' + k.slice(-4) + ' (sin nombre oficial)'
    : titulo(p.NOM_ASEN);
  colonias.push({ k, n: nombre, t: titulo(p.TIPO), cp: p.CP !== '00000' ? p.CP : '' });
  polys[k] = rings;
}

colonias.sort((a, b) => a.n.localeCompare(b.n, 'es'));

const salida = {
  generado: new Date().toISOString().slice(0, 10),
  fuente: 'INEGI DCAH 2024 (límites oficiales, IMPLAN Morelia)',
  colonias,
  polys
};
fs.mkdirSync('public', { recursive: true });
fs.writeFileSync('public/colonias_morelia.json', JSON.stringify(salida));

const kb = Math.round(fs.statSync('public/colonias_morelia.json').size / 1024);
console.log(`Colonias con límites oficiales: ${colonias.length} (descartadas sin nombre/geometría: ${descartadas})`);
console.log(`Archivo: public/colonias_morelia.json (${kb} KB)`);

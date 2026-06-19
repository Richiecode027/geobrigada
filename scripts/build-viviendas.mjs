// Agrega a public/colonias_morelia.json el número de VIVIENDAS HABITADAS por
// colonia (campo "v"), tomado del Censo 2020 del INEGI. Sirve para estimar
// cuánto material llevar a cada colonia y no quedarse corto.
//
// Cruza dos fuentes oficiales del INEGI por la clave de manzana (CVEGEO):
//   1) Conteo de viviendas por manzana (Censo 2020, "AGEB y manzana urbana").
//   2) Geometría de las manzanas (Marco Geoestadístico 2020).
// Cada manzana se asigna a la colonia (DCAH) que contiene su centro.
//
// Se corre una sola vez (o al actualizar el catálogo):
//   node scripts/build-viviendas.mjs

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import shapefile from 'shapefile';
import proj4 from 'proj4';
import { pointInAnyRing } from '../src/lib/geo.js';

const TEMP = process.env.TEMP || '/tmp';

// --- 1) Censo: viviendas por manzana --------------------------------------
const CENSO_URL =
  'https://www.inegi.org.mx/contenidos/programas/ccpv/2020/datosabiertos/ageb_manzana/ageb_mza_urbana_16_cpv2020_csv.zip';
const CENSO_ZIP = path.join(TEMP, 'censo16.zip');
const CENSO_DIR = path.join(TEMP, 'ageb_mza_urbana_16_cpv2020');
const CENSO_CSV = path.join(
  CENSO_DIR,
  'conjunto_de_datos',
  'conjunto_de_datos_ageb_urbana_16_cpv2020.csv'
);

// --- 2) Geometría de manzanas (Marco Geoestadístico) ----------------------
const MG_URL =
  'https://www.inegi.org.mx/contenidos/productos/prod_serv/contenidos/espanol/bvinegi/productos/geografia/marcogeo/889463807469/16_michoacandeocampo.zip';
const MG_ZIP = path.join(TEMP, 'mg16.zip');
const MG_DIR = path.join(TEMP, 'mg16');
const MG_SHP = path.join(MG_DIR, 'conjunto_de_datos', '16m.shp');
const MG_DBF = path.join(MG_DIR, 'conjunto_de_datos', '16m.dbf');

// Misma proyección LCC del INEGI que usa el catálogo de colonias.
const LCC_INEGI =
  '+proj=lcc +lat_1=17.5 +lat_2=29.5 +lat_0=12 +lon_0=-102 +x_0=2500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const aWGS84 = proj4(LCC_INEGI, 'WGS84');

// Viviendas que se asumen en una manzana con dato protegido por el INEGI
// (se oculta cuando hay 1 o 2 viviendas; se asume 2 para no quedarse corto).
const VIV_PROTEGIDA = 2;

function descargar(url, zip, dir, marcador) {
  if (fs.existsSync(marcador)) return;
  if (!fs.existsSync(zip)) {
    console.log('Descargando ' + url.split('/').pop() + '…');
    execSync(
      `powershell -NoProfile -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${zip}' -UserAgent 'GeoBrigada/0.1'"`,
      { stdio: 'inherit' }
    );
  }
  console.log('Descomprimiendo ' + path.basename(zip) + '…');
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zip}' -DestinationPath '${dir}' -Force"`
  );
}

descargar(CENSO_URL, CENSO_ZIP, CENSO_DIR + '_tmp', CENSO_CSV);
// El censo se descomprime con su propia carpeta raíz; ajusta si hizo falta.
if (!fs.existsSync(CENSO_CSV) && fs.existsSync(CENSO_DIR + '_tmp')) {
  fs.renameSync(path.join(CENSO_DIR + '_tmp', path.basename(CENSO_DIR)), CENSO_DIR);
}
descargar(MG_URL, MG_ZIP, MG_DIR, MG_SHP);

// --- lee el censo: CVEGEO de manzana -> viviendas habitadas ----------------
console.log('Leyendo censo…');
const lineas = fs.readFileSync(CENSO_CSV, 'utf8').split('\n');
const cab = lineas[0].replace(/^﻿/, '').split(',');
const idx = (nombre) => cab.indexOf(nombre);
const iEnt = idx('ENTIDAD'), iMun = idx('MUN'), iLoc = idx('LOC');
const iAgeb = idx('AGEB'), iMza = idx('MZA'), iViv = idx('VIVPAR_HAB');

const vivPorManzana = new Map();
let totalCenso = 0;
for (let i = 1; i < lineas.length; i++) {
  const c = lineas[i].split(',');
  if (c.length < cab.length) continue;
  if (c[iMun] !== '053') continue; // solo Morelia
  const mza = c[iMza];
  if (!mza || mza === '000') continue; // saltar filas de totales (estado/mun/AGEB)
  const cvegeo = c[iEnt] + c[iMun] + c[iLoc] + c[iAgeb] + mza;
  const bruto = c[iViv];
  const viv = /^[0-9]+$/.test(bruto) ? parseInt(bruto, 10) : VIV_PROTEGIDA;
  vivPorManzana.set(cvegeo, viv);
  totalCenso += viv;
}
console.log(`Manzanas con dato: ${vivPorManzana.size} · viviendas (Morelia): ${totalCenso}`);

// --- carga el catálogo de colonias y prepara cajas envolventes -------------
const catalogo = JSON.parse(fs.readFileSync('public/colonias_morelia.json', 'utf8'));
const bbox = {}; // clave -> [minLat, minLng, maxLat, maxLng]
for (const c of catalogo.colonias) {
  const rings = catalogo.polys[c.k];
  let minLat = 90, minLng = 180, maxLat = -90, maxLng = -180;
  for (const r of rings)
    for (const [lat, lng] of r) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  bbox[c.k] = [minLat, minLng, maxLat, maxLng];
}

// --- recorre las manzanas, asigna cada una a su colonia --------------------
console.log('Asignando manzanas a colonias…');
const vivPorColonia = {};
for (const c of catalogo.colonias) vivPorColonia[c.k] = 0;
let asignadas = 0, sinColonia = 0, sinGeom = 0;

const src = await shapefile.open(MG_SHP, MG_DBF, { encoding: 'latin1' });
while (true) {
  const r = await src.read();
  if (r.done) break;
  const cvegeo = r.value.properties.CVEGEO;
  if (!cvegeo || !cvegeo.startsWith('16053')) continue;
  const viv = vivPorManzana.get(cvegeo);
  if (!viv) continue; // manzana sin viviendas habitadas (parque, baldío…)

  const g = r.value.geometry;
  const anillo = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates?.[0]?.[0];
  if (!anillo) { sinGeom++; continue; }
  // centro de la manzana (promedio de vértices) reproyectado a [lat,lng]
  let sx = 0, sy = 0;
  for (const [x, y] of anillo) { sx += x; sy += y; }
  const [lon, lat] = aWGS84.forward([sx / anillo.length, sy / anillo.length]);
  const p = [lat, lon];

  // ¿en qué colonia cae el centro? (prefiltro por caja envolvente)
  let puesta = false;
  for (const c of catalogo.colonias) {
    const b = bbox[c.k];
    if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
    if (pointInAnyRing(p, catalogo.polys[c.k])) {
      vivPorColonia[c.k] += viv;
      asignadas++;
      puesta = true;
      break;
    }
  }
  if (!puesta) sinColonia++;
}

// --- escribe el campo "v" (viviendas) en cada colonia ----------------------
let conDato = 0, sumaAsignada = 0;
for (const c of catalogo.colonias) {
  const v = Math.round(vivPorColonia[c.k]);
  c.v = v;
  if (v > 0) conDato++;
  sumaAsignada += v;
}
catalogo.fuenteViviendas = 'INEGI Censo 2020 (viviendas particulares habitadas por manzana)';
fs.writeFileSync('public/colonias_morelia.json', JSON.stringify(catalogo));

const kb = Math.round(fs.statSync('public/colonias_morelia.json').size / 1024);
console.log('--------------------------------------------------');
console.log(`Manzanas asignadas a una colonia: ${asignadas}`);
console.log(`Manzanas fuera de toda colonia DCAH: ${sinColonia} · sin geometría: ${sinGeom}`);
console.log(`Colonias con viviendas: ${conDato} de ${catalogo.colonias.length}`);
console.log(`Viviendas asignadas a colonias: ${sumaAsignada} de ${totalCenso} del censo`);
console.log(`Archivo: public/colonias_morelia.json (${kb} KB)`);

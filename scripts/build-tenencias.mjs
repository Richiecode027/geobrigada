// Agrega al catálogo las TENENCIAS y localidades fuera de la ciudad (Capula,
// Jesús del Monte, Tenencia Morelos...) que el DCAH del IMPLAN no delimita
// pero que sí tienen manzanas oficiales con vivienda en el INEGI.
//
// Cómo funciona:
//   1) Recorre las mismas manzanas del Marco Geoestadístico que usa
//      build-viviendas.mjs, y se queda con las que NO caen dentro de
//      ninguna colonia ya existente (huérfanas), agrupadas por localidad
//      (CVE_LOC) — cada tenencia es una localidad distinta.
//   2) Para cada localidad "suelda" sus manzanas en un solo contorno: las
//      agranda un poco (buffer), las une, y las regresa a su tamaño real
//      (erosiona) — así las manzanas separadas por una calle quedan en una
//      sola pieza en vez de islas sueltas.
//   3) Agrega cada tenencia al catálogo con su nombre oficial del censo y
//      sus viviendas reales (no estimadas).
//
// Se corre DESPUÉS de build-colonias.mjs y build-viviendas.mjs:
//   node scripts/build-tenencias.mjs
//
// Requiere los mismos archivos de INEGI que build-viviendas.mjs (los reusa
// de TEMP si ya se descargaron).

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import shapefile from 'shapefile';
import proj4 from 'proj4';
import * as turf from '@turf/turf';
import { pointInAnyRing, simplifyRing } from '../src/lib/geo.js';

const TEMP = process.env.TEMP || '/tmp';

const CENSO_URL =
  'https://www.inegi.org.mx/contenidos/programas/ccpv/2020/datosabiertos/ageb_manzana/ageb_mza_urbana_16_cpv2020_csv.zip';
const CENSO_ZIP = path.join(TEMP, 'censo16.zip');
const CENSO_DIR = path.join(TEMP, 'ageb_mza_urbana_16_cpv2020');
const CENSO_CSV = path.join(
  CENSO_DIR,
  'conjunto_de_datos',
  'conjunto_de_datos_ageb_urbana_16_cpv2020.csv'
);

const MG_URL =
  'https://www.inegi.org.mx/contenidos/productos/prod_serv/contenidos/espanol/bvinegi/productos/geografia/marcogeo/889463807469/16_michoacandeocampo.zip';
const MG_ZIP = path.join(TEMP, 'mg16.zip');
const MG_DIR = path.join(TEMP, 'mg16');
const MG_SHP = path.join(MG_DIR, 'conjunto_de_datos', '16m.shp');
const MG_DBF = path.join(MG_DIR, 'conjunto_de_datos', '16m.dbf');

const LCC_INEGI =
  '+proj=lcc +lat_1=17.5 +lat_2=29.5 +lat_0=12 +lon_0=-102 +x_0=2500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const aWGS84 = proj4(LCC_INEGI, 'WGS84');

const VIV_PROTEGIDA = 2;
// La localidad 0001 es la propia ciudad de Morelia: sus manzanas "huérfanas"
// son huecos sueltos por toda la ciudad (bordes, fraccionamientos nuevos),
// no una tenencia — se dejan fuera de este script (quedan para otro día).
const LOC_CIUDAD = '0001';
// Localidades con menos viviendas huérfanas que esto no se agregan (evita
// meter caseríos sueltos de 2-3 casas como si fueran una tenencia).
const MIN_VIVIENDAS = 20;
// Cuánto se "sueldan" las manzanas vecinas (separadas por una calle) en un
// solo contorno. Se agranda y se vuelve a encoger esta misma distancia.
const SOLDADURA_M = 15;

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
if (!fs.existsSync(CENSO_CSV) && fs.existsSync(CENSO_DIR + '_tmp')) {
  fs.renameSync(path.join(CENSO_DIR + '_tmp', path.basename(CENSO_DIR)), CENSO_DIR);
}
descargar(MG_URL, MG_ZIP, MG_DIR, MG_SHP);

// --- lee el censo: viviendas por manzana y nombre de cada localidad --------
console.log('Leyendo censo…');
const lineas = fs.readFileSync(CENSO_CSV, 'utf8').split('\n');
const cab = lineas[0].replace(/^﻿/, '').split(',');
const idx = (nombre) => cab.indexOf(nombre);
const iEnt = idx('ENTIDAD'), iMun = idx('MUN'), iLoc = idx('LOC');
const iAgeb = idx('AGEB'), iMza = idx('MZA'), iViv = idx('VIVPAR_HAB'), iNomLoc = idx('NOM_LOC');

const vivPorManzana = new Map();
const nombrePorLoc = new Map();
for (let i = 1; i < lineas.length; i++) {
  const c = lineas[i].split(',');
  if (c.length < cab.length) continue;
  if (c[iMun] !== '053') continue; // solo Morelia
  const mza = c[iMza];
  if (!mza || mza === '000') continue; // saltar filas de totales
  const cvegeo = c[iEnt] + c[iMun] + c[iLoc] + c[iAgeb] + mza;
  const bruto = c[iViv];
  const viv = /^[0-9]+$/.test(bruto) ? parseInt(bruto, 10) : VIV_PROTEGIDA;
  vivPorManzana.set(cvegeo, viv);
  if (!nombrePorLoc.has(c[iLoc])) nombrePorLoc.set(c[iLoc], c[iNomLoc].trim());
}

// --- carga el catálogo actual (926 zonas DCAH) y sus cajas envolventes -----
const catalogo = JSON.parse(fs.readFileSync('public/colonias_morelia.json', 'utf8'));
const bbox = {};
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

// --- recorre las manzanas: agrupa las HUÉRFANAS por localidad --------------
console.log('Buscando manzanas fuera de toda colonia…');
const porLoc = new Map(); // loc -> { viviendas, manzanas: [turf Polygon] }
const src = await shapefile.open(MG_SHP, MG_DBF, { encoding: 'latin1' });
while (true) {
  const r = await src.read();
  if (r.done) break;
  const cvegeo = r.value.properties.CVEGEO;
  if (!cvegeo || !cvegeo.startsWith('16053')) continue;
  const viv = vivPorManzana.get(cvegeo);
  if (!viv) continue;

  const loc = cvegeo.slice(5, 9);
  if (loc === LOC_CIUDAD) continue;

  const g = r.value.geometry;
  if (g.type !== 'Polygon') continue; // las manzanas urbanas de Morelia son Polygon simple
  const anillo = g.coordinates[0];

  // centro (para el filtro de "¿ya está en una colonia?") y contorno completo
  // (para poder soldar la manzana con sus vecinas), ambos reproyectados.
  let sx = 0, sy = 0;
  for (const [x, y] of anillo) { sx += x; sy += y; }
  const [lonC, latC] = aWGS84.forward([sx / anillo.length, sy / anillo.length]);

  let dentroDeAlguna = false;
  for (const c of catalogo.colonias) {
    const b = bbox[c.k];
    if (latC < b[0] || latC > b[2] || lonC < b[1] || lonC > b[3]) continue;
    if (pointInAnyRing([latC, lonC], catalogo.polys[c.k])) { dentroDeAlguna = true; break; }
  }
  if (dentroDeAlguna) continue;

  const anilloWGS = anillo.map(([x, y]) => aWGS84.forward([x, y])); // [lon,lat], formato GeoJSON
  let entrada = porLoc.get(loc);
  if (!entrada) { entrada = { viviendas: 0, manzanas: [] }; porLoc.set(loc, entrada); }
  entrada.viviendas += viv;
  entrada.manzanas.push(turf.polygon([anilloWGS]));
}

// --- suelda las manzanas de cada localidad en un contorno y lo agrega ------
console.log('Soldando manzanas por localidad…');

// Convierte una colonia del catálogo ([lat,lng]) a un polígono turf ([lon,lat]),
// cerrando el anillo (primer punto = último) solo si hiciera falta.
function cerrar(coords) {
  const a = coords[0], b = coords[coords.length - 1];
  return a[0] === b[0] && a[1] === b[1] ? coords : [...coords, a];
}
function aTurfPoly(k) {
  return turf.multiPolygon(
    catalogo.polys[k].map((r) => [cerrar(r.map(([lat, lng]) => [lng, lat]))])
  );
}

let agregadas = 0, vivAgregadas = 0, recortadas = 0;
const omitidas = [];
for (const [loc, { viviendas, manzanas }] of porLoc) {
  const nombre = nombrePorLoc.get(loc) || ('Localidad ' + loc);
  if (viviendas < MIN_VIVIENDAS) { omitidas.push(`${nombre} (${viviendas} viv.)`); continue; }

  const agrandadas = manzanas.map((m) => turf.buffer(m, SOLDADURA_M, { units: 'meters' }));
  const unido =
    agrandadas.length === 1
      ? agrandadas[0]
      : turf.union(turf.featureCollection(agrandadas));
  let encogido = turf.buffer(unido, -SOLDADURA_M, { units: 'meters' });
  if (!encogido) { omitidas.push(`${nombre} (geometría inválida al encoger)`); continue; }

  // El "soldado" (agrandar y encoger) puede inflarse un poco hacia el borde de
  // una colonia vecina ya existente: se recorta cualquier traslape para que
  // nunca queden dos zonas pisándose en el mapa.
  const [minLng, minLat, maxLng, maxLat] = turf.bbox(encogido);
  const vecinas = catalogo.colonias.filter((c) => {
    const b = bbox[c.k];
    return b && !(maxLat < b[0] || minLat > b[2] || maxLng < b[1] || minLng > b[3]);
  });
  if (vecinas.length > 0) {
    const poligonosVecinos = vecinas.map((c) => aTurfPoly(c.k));
    const unionVecinas =
      poligonosVecinos.length === 1
        ? poligonosVecinos[0]
        : turf.union(turf.featureCollection(poligonosVecinos));
    const areaAntes = turf.area(encogido);
    const recortado = turf.difference(turf.featureCollection([encogido, unionVecinas]));
    if (recortado) {
      if (turf.area(recortado) < areaAntes - 1) recortadas++; // sí quitó algo real
      encogido = recortado;
    }
  }

  // Extrae los anillos exteriores (una localidad puede quedar en varias
  // piezas si sus manzanas están repartidas en grupos separados).
  const geom = encogido.geometry;
  const partes =
    geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  const rings = [];
  for (const parte of partes) {
    const anillo = parte[0].map(([lon, lat]) => [
      Math.round(lat * 1e5) / 1e5,
      Math.round(lon * 1e5) / 1e5
    ]);
    const simple = simplifyRing(anillo, 10);
    if (simple.length >= 4) rings.push(simple); // descarta piezas minúsculas/ruido
  }
  if (rings.length === 0) { omitidas.push(`${nombre} (sin contorno útil)`); continue; }

  const k = 'T16053' + loc;
  catalogo.colonias.push({ k, n: nombre, t: 'Tenencia', cp: '', v: Math.round(viviendas) });
  catalogo.polys[k] = rings;
  agregadas++;
  vivAgregadas += viviendas;
}

catalogo.colonias.sort((a, b) => a.n.localeCompare(b.n, 'es'));
catalogo.fuenteTenencias =
  'INEGI Marco Geoestadístico + Censo 2020: manzanas fuera del DCAH agrupadas por localidad';
fs.writeFileSync('public/colonias_morelia.json', JSON.stringify(catalogo));

const kb = Math.round(fs.statSync('public/colonias_morelia.json').size / 1024);
console.log('--------------------------------------------------');
console.log(`Tenencias agregadas: ${agregadas} · viviendas: ${Math.round(vivAgregadas)}`);
console.log(`Recortadas por traslape con una colonia vecina: ${recortadas}`);
if (omitidas.length) console.log(`Omitidas (menos de ${MIN_VIVIENDAS} viviendas o sin geometría): ${omitidas.join(', ')}`);
console.log(`Catálogo total: ${catalogo.colonias.length} zonas`);
console.log(`Archivo: public/colonias_morelia.json (${kb} KB)`);

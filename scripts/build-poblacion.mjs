// Agrega a cada zona de public/colonias_morelia.json tres datos del Censo
// 2020 del INEGI, además de las viviendas habitadas ("v") que ya traía:
//   vt = viviendas TOTALES (habitadas + deshabitadas + de uso temporal +
//        colectivas). Columna VIVTOT del censo.
//   p  = población total (personas). Columna POBTOT.
//   d  = densidad de población: personas por km² de la zona (p / área del
//        polígono). Es densidad BRUTA: el área incluye parques, calles y
//        terrenos baldíos dentro de la colonia.
//
// NO toca "v" ni los polígonos: "v" sigue siendo lo que usan las estimaciones
// de material y el reparto entre brigadas (el material se entrega en casas
// donde vive alguien). Por eso se corre APARTE, después de los otros tres
// pasos del catálogo (build-colonias → build-viviendas → build-tenencias), y
// se puede correr las veces que haga falta: recalcula todo desde cero.
//
// Cada manzana se asigna con las MISMAS reglas que ya usan esos scripts, para
// que los números cuadren con "v":
//   - Zonas del IMPLAN (DCAH): la zona que contiene el centro de la manzana.
//   - Tenencias (clave T16053<loc>): las manzanas de esa localidad que no
//     cayeron en ninguna zona del IMPLAN.
//
// Uso:  node scripts/build-poblacion.mjs
// Reusa de TEMP los mismos archivos del INEGI que build-viviendas.mjs (los
// descarga si no están).

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import shapefile from 'shapefile';
import proj4 from 'proj4';
import * as turf from '@turf/turf';
import { pointInAnyRing } from '../src/lib/geo.js';

const TEMP = process.env.TEMP || '/tmp';

const CENSO_URL =
  'https://www.inegi.org.mx/contenidos/programas/ccpv/2020/datosabiertos/ageb_manzana/ageb_mza_urbana_16_cpv2020_csv.zip';
const CENSO_ZIP = path.join(TEMP, 'censo16.zip');
const CENSO_DIR = path.join(TEMP, 'ageb_mza_urbana_16_cpv2020');
const CENSO_CSV = path.join(CENSO_DIR, 'conjunto_de_datos', 'conjunto_de_datos_ageb_urbana_16_cpv2020.csv');

const MG_URL =
  'https://www.inegi.org.mx/contenidos/productos/prod_serv/contenidos/espanol/bvinegi/productos/geografia/marcogeo/889463807469/16_michoacandeocampo.zip';
const MG_ZIP = path.join(TEMP, 'mg16.zip');
const MG_DIR = path.join(TEMP, 'mg16');
const MG_SHP = path.join(MG_DIR, 'conjunto_de_datos', '16m.shp');
const MG_DBF = path.join(MG_DIR, 'conjunto_de_datos', '16m.dbf');

const LCC_INEGI =
  '+proj=lcc +lat_1=17.5 +lat_2=29.5 +lat_0=12 +lon_0=-102 +x_0=2500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const aWGS84 = proj4(LCC_INEGI, 'WGS84');

// Igual que build-viviendas.mjs: el INEGI oculta las habitadas cuando son 1 o 2.
const VIV_PROTEGIDA = 2;
const LOC_CIUDAD = '0001';

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
  execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zip}' -DestinationPath '${dir}' -Force"`);
}

descargar(CENSO_URL, CENSO_ZIP, CENSO_DIR + '_tmp', CENSO_CSV);
if (!fs.existsSync(CENSO_CSV) && fs.existsSync(CENSO_DIR + '_tmp')) {
  fs.renameSync(path.join(CENSO_DIR + '_tmp', path.basename(CENSO_DIR)), CENSO_DIR);
}
descargar(MG_URL, MG_ZIP, MG_DIR, MG_SHP);

// --- censo: por manzana, habitadas (para cuadrar), totales y población ------
console.log('Leyendo censo…');
const lineas = fs.readFileSync(CENSO_CSV, 'utf8').split('\n');
const cab = lineas[0].replace(/^﻿/, '').trim().split(',');
const idx = (n) => cab.indexOf(n);
const iEnt = idx('ENTIDAD'), iMun = idx('MUN'), iLoc = idx('LOC'), iAgeb = idx('AGEB'), iMza = idx('MZA');
const iHab = idx('VIVPAR_HAB'), iTot = idx('VIVTOT'), iPob = idx('POBTOT');
const num = (s) => (/^[0-9]+$/.test((s || '').trim()) ? parseInt(s, 10) : null);

const porManzana = new Map(); // cvegeo -> { hab, tot, pob }
let municipal = null;
for (let i = 1; i < lineas.length; i++) {
  const c = lineas[i].split(',');
  if (c.length < cab.length || c[iMun] !== '053') continue;
  if (c[iLoc] === '0000' && c[iAgeb] === '0000' && c[iMza] === '000') {
    municipal = { tot: num(c[iTot]), pob: num(c[iPob]) };
  }
  if (!c[iMza] || c[iMza] === '000') continue;
  const hab = num(c[iHab]) ?? VIV_PROTEGIDA;
  // VIVTOT nunca viene oculto, pero si las habitadas se ASUMIERON en 2 y el
  // total real es 1, el total no puede quedar por debajo de las habitadas.
  const tot = Math.max(num(c[iTot]) ?? 0, hab);
  const pob = num(c[iPob]) ?? 0;
  porManzana.set(c[iEnt] + c[iMun] + c[iLoc] + c[iAgeb] + c[iMza], { hab, tot, pob });
}

// --- catálogo: separa zonas del IMPLAN de tenencias -------------------------
const catalogo = JSON.parse(fs.readFileSync('public/colonias_morelia.json', 'utf8'));
const esTenencia = (c) => c.k.startsWith('T');
const dcah = catalogo.colonias.filter((c) => !esTenencia(c));
const bbox = {};
for (const c of dcah) {
  let a = 90, b = 180, d = -90, e = -180;
  for (const r of catalogo.polys[c.k]) for (const [lat, lng] of r) {
    if (lat < a) a = lat; if (lat > d) d = lat; if (lng < b) b = lng; if (lng > e) e = lng;
  }
  bbox[c.k] = [a, b, d, e];
}
const suma = {};
for (const c of catalogo.colonias) suma[c.k] = { hab: 0, tot: 0, pob: 0 };

// --- recorre manzanas -------------------------------------------------------
console.log('Asignando manzanas…');
let enDcah = 0, enTenencia = 0, fuera = 0;
const fueraDeTodo = { tot: 0, pob: 0 };
const src = await shapefile.open(MG_SHP, MG_DBF, { encoding: 'latin1' });
while (true) {
  const r = await src.read();
  if (r.done) break;
  const cvegeo = r.value.properties.CVEGEO;
  if (!cvegeo || !cvegeo.startsWith('16053')) continue;
  const dato = porManzana.get(cvegeo);
  if (!dato || (dato.tot === 0 && dato.pob === 0)) continue;

  const g = r.value.geometry;
  const anillo = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates?.[0]?.[0];
  if (!anillo) continue;
  let sx = 0, sy = 0;
  for (const [x, y] of anillo) { sx += x; sy += y; }
  const [lon, lat] = aWGS84.forward([sx / anillo.length, sy / anillo.length]);

  let destino = null;
  for (const c of dcah) {
    const b = bbox[c.k];
    if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
    if (pointInAnyRing([lat, lon], catalogo.polys[c.k])) { destino = c.k; break; }
  }
  if (destino) enDcah++;
  else {
    const loc = cvegeo.slice(5, 9);
    const kT = 'T16053' + loc;
    if (loc !== LOC_CIUDAD && suma[kT]) { destino = kT; enTenencia++; }
  }
  if (!destino) { fuera++; fueraDeTodo.tot += dato.tot; fueraDeTodo.pob += dato.pob; continue; }
  suma[destino].hab += dato.hab;
  suma[destino].tot += dato.tot;
  suma[destino].pob += dato.pob;
}

// --- escribe vt, p, d -------------------------------------------------------
const cerrar = (r) => (r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1] ? r : [...r, r[0]]);
let difHab = 0, totVt = 0, totP = 0;
const raras = [];
for (const c of catalogo.colonias) {
  const s = suma[c.k];
  // Área en km² del polígono de la zona (puede venir en varias piezas).
  let km2 = 0;
  for (const r of catalogo.polys[c.k]) {
    if (r.length < 3) continue;
    km2 += turf.area(turf.polygon([cerrar(r.map(([la, lo]) => [lo, la]))])) / 1e6;
  }
  c.vt = Math.max(s.tot, c.v || 0);
  c.p = s.pob;
  c.d = km2 > 0 ? Math.round(s.pob / km2) : 0;
  totVt += c.vt;
  totP += c.p;
  if (s.hab !== (c.v || 0)) { difHab++; if (raras.length < 8) raras.push(`${c.n}: v=${c.v} recalculado=${s.hab}`); }
}
catalogo.fuentePoblacion =
  'INEGI Censo 2020 por manzana: vt = VIVTOT (viviendas totales), p = POBTOT (población), d = p / área km²';
fs.writeFileSync('public/colonias_morelia.json', JSON.stringify(catalogo));

const kb = Math.round(fs.statSync('public/colonias_morelia.json').size / 1024);
console.log('--------------------------------------------------');
console.log(`Manzanas: ${enDcah} en zonas del IMPLAN · ${enTenencia} en tenencias · ${fuera} fuera de toda zona`);
console.log(`Viviendas totales asignadas: ${totVt} · población asignada: ${totP}`);
if (municipal) console.log(`Total oficial del municipio: ${municipal.tot} viviendas · ${municipal.pob} personas`);
console.log(`Fuera de toda zona (no se pueden ubicar en una colonia): ${fueraDeTodo.tot} viviendas · ${fueraDeTodo.pob} personas`);
console.log(`Zonas cuyo recálculo de habitadas NO cuadra con "v": ${difHab}${raras.length ? ' → ' + raras.join(' | ') : ''}`);
console.log(`Archivo: public/colonias_morelia.json (${kb} KB)`);

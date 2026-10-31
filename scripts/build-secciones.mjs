// Genera public/secciones_morelia.json: las SECCIONES ELECTORALES del INE en el
// municipio de Morelia, con su contorno y datos del Censo 2020 (viviendas y
// personas), para buscarlas por número, verlas en el mapa y planear rutas por
// sección igual que por colonia.
//
// Fuente del contorno: la misma "BGD - BASE GEOGRÁFICA DIGITAL" del INE que usa
// build-distritos.mjs (capa SECCION), https://cartografia.ine.mx/sige8/
// productosCartograficos/bases → Michoacán → Shapefile (~58 MB .7z). OJO: el
// INE numera los municipios distinto que el INEGI — Morelia es el 54 para el
// INE y el 053 para el INEGI; por eso se busca por NOMBRE en la capa MUNICIPIO.
//
// Datos del censo: cada manzana del INEGI (mismos archivos que
// build-viviendas.mjs / build-poblacion.mjs, se reusan de TEMP) se asigna a la
// sección que contiene su centro:
//   v  = viviendas habitadas · vt = viviendas totales · p = personas
//   d  = personas por km² (bruta, área completa de la sección)
// Son del 2020 y aproximadas: el INE redibuja secciones y el centro de una
// manzana partida puede caer de un lado o del otro.
//
// Mismo formato que colonias_morelia.json ({ colonias, polys }) para que
// src/lib/colonias.js las trate igual: clave "S" + número (S2881).
//
// Uso:  node scripts/build-secciones.mjs "<ruta al .7z del INE>"

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unpackSome } from '7zip-min';
import * as shapefile from 'shapefile';
import proj4 from 'proj4';
import * as turf from '@turf/turf';
import { simplifyRing, pointInAnyRing } from '../src/lib/geo.js';

const archivo = process.argv[2];
if (!archivo) {
  console.error('Falta el archivo. Uso: node scripts/build-secciones.mjs "<ruta al .7z del INE>"');
  process.exit(1);
}
const SALIDA = 'public/secciones_morelia.json';
const UTM14N = '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs';
const LCC_INEGI =
  '+proj=lcc +lat_1=17.5 +lat_2=29.5 +lat_0=12 +lon_0=-102 +x_0=2500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
const TIPO = { 1: 'Urbana', 2: 'Urbana', 3: 'Mixta', 4: 'Rural' };
const TOLERANCIA_M = 6; // simplificación del contorno: suficiente para ver calles

// --- 1) capas del INE ---------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'geobrigada-secc-'));
console.log('Extrayendo SECCION y MUNICIPIO…');
const quiero = [];
for (const capa of ['SECCION', 'MUNICIPIO']) for (const ext of ['shp', 'dbf', 'shx', 'prj']) quiero.push('*' + capa + '.' + ext);
await unpackSome(archivo, quiero, tmp);
function buscarCarpeta(dir) {
  if (fs.existsSync(path.join(dir, 'SECCION.shp'))) return dir;
  for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const h = buscarCarpeta(path.join(dir, sub.name));
    if (h) return h;
  }
  return null;
}
const dir = buscarCarpeta(tmp);
if (!dir) { console.error('No se encontró SECCION.shp en el archivo.'); process.exit(1); }
async function leer(nombre) {
  const src = await shapefile.open(path.join(dir, nombre + '.shp'), path.join(dir, nombre + '.dbf'));
  const out = [];
  for (let r = await src.read(); !r.done; r = await src.read()) out.push(r.value);
  return out;
}
const morelia = (await leer('MUNICIPIO')).find((m) => /^MORELIA$/i.test(String(m.properties.nombre).trim()));
if (!morelia) { console.error('No se encontró Morelia en la capa MUNICIPIO.'); process.exit(1); }
const numMun = morelia.properties.municipio;
const secciones = (await leer('SECCION')).filter((s) => s.properties.municipio === numMun);
console.log(`Morelia = municipio ${numMun} del INE · ${secciones.length} secciones`);
if (secciones.length < 100) { console.error('Muy pocas secciones: algo se leyó mal. No se escribió nada.'); process.exit(1); }

// --- 2) contornos en [lat,lng] -----------------------------------------------
const aLatLng = ([x, y]) => { const [lng, lat] = proj4(UTM14N, 'WGS84', [x, y]); return [lat, lng]; };
const exteriores = (g) => (g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((p) => p[0]));
const zonas = secciones.map((s) => {
  const p = s.properties;
  const crudos = exteriores(s.geometry).map((a) => a.map(aLatLng)); // sin simplificar, para asignar manzanas
  let minLat = 90, minLng = 180, maxLat = -90, maxLng = -180;
  for (const r of crudos) for (const [la, lo] of r) {
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la; if (lo < minLng) minLng = lo; if (lo > maxLng) maxLng = lo;
  }
  // Área en m² directo de UTM (metros), sin pelear con grados.
  let m2 = 0;
  for (const r of exteriores(s.geometry)) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    m2 += Math.abs(a) / 2;
  }
  return {
    k: 'S' + p.seccion, s: p.seccion, dl: p.distrito_l, df: p.distrito_f, tipo: TIPO[p.tipo] || '',
    crudos, caja: [minLat, minLng, maxLat, maxLng], km2: m2 / 1e6, v: 0, vt: 0, p: 0
  };
});

// --- 3) censo por manzana (opcional: si faltan los archivos, sale sin datos) --
const TEMP = process.env.TEMP || os.tmpdir();
const CSV = path.join(TEMP, 'ageb_mza_urbana_16_cpv2020', 'conjunto_de_datos', 'conjunto_de_datos_ageb_urbana_16_cpv2020.csv');
const MG = path.join(TEMP, 'mg16', 'conjunto_de_datos');
let conCenso = false;
if (fs.existsSync(CSV) && fs.existsSync(path.join(MG, '16m.shp'))) {
  console.log('Asignando manzanas del Censo 2020 a secciones…');
  const L = fs.readFileSync(CSV, 'utf8').split('\n');
  const cab = L[0].replace(/^﻿/, '').trim().split(',');
  const ix = (n) => cab.indexOf(n);
  const num = (s) => (/^[0-9]+$/.test((s || '').trim()) ? parseInt(s, 10) : null);
  const datos = new Map();
  for (let i = 1; i < L.length; i++) {
    const c = L[i].split(',');
    if (c[ix('MUN')] !== '053' || !c[ix('MZA')] || c[ix('MZA')] === '000') continue;
    const hab = num(c[ix('VIVPAR_HAB')]) ?? 2; // oculto por el INEGI = 1 o 2: se asume 2, como build-viviendas
    datos.set(c[ix('ENTIDAD')] + c[ix('MUN')] + c[ix('LOC')] + c[ix('AGEB')] + c[ix('MZA')], {
      hab, tot: Math.max(num(c[ix('VIVTOT')]) ?? 0, hab), pob: num(c[ix('POBTOT')]) ?? 0
    });
  }
  const aWGS = proj4(LCC_INEGI, 'WGS84');
  const src = await shapefile.open(path.join(MG, '16m.shp'), path.join(MG, '16m.dbf'), { encoding: 'latin1' });
  let puestas = 0, fuera = 0;
  for (let r = await src.read(); !r.done; r = await src.read()) {
    const cvegeo = r.value.properties.CVEGEO;
    if (!cvegeo || !cvegeo.startsWith('16053')) continue;
    const d = datos.get(cvegeo);
    if (!d) continue;
    const g = r.value.geometry;
    const an = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates?.[0]?.[0];
    if (!an) continue;
    let sx = 0, sy = 0;
    for (const [x, y] of an) { sx += x; sy += y; }
    const [lon, lat] = aWGS.forward([sx / an.length, sy / an.length]);
    const z = zonas.find((z) => lat >= z.caja[0] && lat <= z.caja[2] && lon >= z.caja[1] && lon <= z.caja[3] && pointInAnyRing([lat, lon], z.crudos));
    if (!z) { fuera++; continue; }
    z.v += d.hab; z.vt += d.tot; z.p += d.pob; puestas++;
  }
  conCenso = true;
  console.log(`Manzanas asignadas: ${puestas} · fuera de toda sección: ${fuera}`);
} else {
  console.log('(No están los archivos del censo en TEMP: las secciones salen sin viviendas ni personas.)');
}

// --- 4) escribir --------------------------------------------------------------
zonas.sort((a, b) => a.s - b.s);
const salida = { generado: new Date().toISOString().slice(0, 10), fuente: 'INE BGD (capa SECCION)' + (conCenso ? ' + INEGI Censo 2020 por manzana' : ''), colonias: [], polys: {} };
for (const z of zonas) {
  const rings = z.crudos.map((r) => simplifyRing(r, TOLERANCIA_M).map(([la, lo]) => [+la.toFixed(5), +lo.toFixed(5)])).filter((r) => r.length >= 4);
  salida.polys[z.k] = rings;
  const fila = { k: z.k, n: 'Sección ' + z.s, t: 'Electoral ' + z.tipo.toLowerCase(), s: z.s, dl: z.dl, df: z.df };
  if (conCenso) Object.assign(fila, { v: z.v, vt: z.vt, p: z.p, d: z.km2 > 0 ? Math.round(z.p / z.km2) : 0 });
  salida.colonias.push(fila);
}
fs.writeFileSync(SALIDA, JSON.stringify(salida));
fs.rmSync(tmp, { recursive: true, force: true });
const tot = salida.colonias.reduce((a, c) => ({ v: a.v + (c.v || 0), p: a.p + (c.p || 0) }), { v: 0, p: 0 });
console.log(`✅ ${SALIDA}: ${salida.colonias.length} secciones (${salida.colonias[0].s}–${salida.colonias.at(-1).s}) · ${tot.v} viviendas habitadas · ${tot.p} personas · ${Math.round(fs.statSync(SALIDA).size / 1024)} KB`);

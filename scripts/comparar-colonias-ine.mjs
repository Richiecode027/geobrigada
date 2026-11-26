// Compara las colonias del INE (capa COLONIA de la BGD, la misma base de
// build-secciones.mjs) con el catálogo del INEGI que usa la app
// (public/colonias_morelia.json), para encontrar NOMBRES ALTERNOS con fuente
// oficial: el mismo lugar llamado distinto por cada institución.
//
// Cruza por UBICACIÓN, no por nombre: a cada colonia del INE se le busca la
// zona del INEGI con la que más se enciman (área compartida). Tres tipos de
// hallazgo, de más a menos confiable:
//   A) El INE pone el otro nombre entre paréntesis: "LOMAS DE MORELIA (DR
//      IGNACIO CHAVEZ)". Es el INE mismo diciendo que son el mismo lugar.
//   B) Los dos contornos son casi el mismo (cada uno cubre ≥ 70 % del otro)
//      pero el nombre es distinto: mismo lugar, otro nombre.
//   C) El nombre es distinto y solo se enciman en parte: suele ser una
//      subdivisión (etapas, secciones) — se lista aparte, para revisar a mano.
// No escribe nada en la app: el resultado es un reporte para decidir qué se
// agrega a src/lib/nombresAlternos.js.
//
// Uso: node scripts/comparar-colonias-ine.mjs ["<.7z del INE>"]
//   (por defecto datos-fuente/ine/16 MICHOACAN DE OCAMPO.7z)
// Sale en datos-fuente/ine/comparacion-colonias.json y se resume en pantalla.

import fs from 'node:fs';
import path from 'node:path';
import { unpackSome } from '7zip-min';
import * as shapefile from 'shapefile';
import proj4 from 'proj4';
import * as turf from '@turf/turf';

const ARCHIVO = process.argv[2] || 'datos-fuente/ine/16 MICHOACAN DE OCAMPO.7z';
const DESTINO = 'datos-fuente/ine/extraido';
const SALIDA = 'datos-fuente/ine/comparacion-colonias.json';
const UTM14N = '+proj=utm +zone=14 +datum=WGS84 +units=m +no_defs';
const MUNICIPIO_INE = 54; // Morelia para el INE (el INEGI la numera 053)

// --- 1) capa COLONIA del INE ---------------------------------------------------
function buscar(dir, nombre) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toUpperCase() === nombre) return p;
    if (e.isDirectory()) { const h = buscar(p, nombre); if (h) return h; }
  }
  return null;
}
if (!buscar(DESTINO, 'COLONIA.SHP')) {
  console.log('Extrayendo COLONIA del archivo del INE…');
  const q = [];
  for (const c of ['COLONIA', 'COLONIA_PUNTUAL']) for (const e of ['shp', 'dbf', 'shx', 'prj']) q.push('*' + c + '.' + e);
  await unpackSome(ARCHIVO, q, DESTINO);
}
async function leer(capa) {
  const shp = buscar(DESTINO, capa + '.SHP');
  // la librería exige que la ruta del .dbf termine en ".dbf" en minúsculas
  const dbf = shp.replace(/\.shp$/i, '.dbf');
  const src = await shapefile.open(shp, dbf, { encoding: 'latin1' });
  const out = [];
  for (let r = await src.read(); !r.done; r = await src.read()) {
    if (r.value.properties.MUNICIPIO === MUNICIPIO_INE) out.push(r.value);
  }
  return out;
}
const aWgs = ([x, y]) => proj4(UTM14N, 'WGS84', [x, y]);
const reproyectar = (g) =>
  g.type === 'Polygon'
    ? turf.polygon(g.coordinates.map((r) => r.map(aWgs)))
    : turf.multiPolygon(g.coordinates.map((p) => p.map((r) => r.map(aWgs))));

const ine = (await leer('COLONIA')).filter((f) => f.geometry).map((f) => {
  const geo = reproyectar(f.geometry);
  return { nombre: f.properties.NOMBRE.trim(), cp: f.properties.CP, geo, bbox: turf.bbox(geo), area: turf.area(geo) };
});
const puntuales = (await leer('COLONIA_PUNTUAL')).filter((f) => f.geometry).map((f) => ({
  nombre: f.properties.NOMBRE.trim(), cp: f.properties.CP, punto: aWgs(f.geometry.coordinates)
}));
console.log(`INE: ${ine.length} colonias con contorno + ${puntuales.length} solo como punto`);

// --- 2) catálogo INEGI de la app ----------------------------------------------
const { colonias, polys } = JSON.parse(fs.readFileSync('public/colonias_morelia.json', 'utf8'));
const inegi = colonias.map((c) => {
  const anillos = (polys[c.k] || []).map((r) => {
    const ll = r.map(([lat, lng]) => [lng, lat]);
    const a = ll[0], b = ll[ll.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) ll.push(a);
    return ll;
  }).filter((r) => r.length >= 4);
  if (!anillos.length) return null;
  const geo = anillos.length === 1 ? turf.polygon([anillos[0]]) : turf.multiPolygon(anillos.map((r) => [r]));
  return { k: c.k, n: c.n, t: c.t, v: c.v, geo, bbox: turf.bbox(geo), area: turf.area(geo) };
}).filter(Boolean);

// --- 3) comparar ---------------------------------------------------------------
const norm = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[.,"'()\-]/g, ' ')
    .replace(/\bAMP\b/g, 'AMPLIACION')
    .replace(/\b(COL|COLONIA|FRACC|FRACCIONAMIENTO|U HAB|UNIDAD HABITACIONAL|CONJ HAB|CONJUNTO HABITACIONAL|RES|RESIDENCIAL|INFONAVIT|FOVISSSTE|DR|DOCTOR|LIC|GRAL|GENERAL|ING|PROF|EL|LA|LOS|LAS|DE|DEL|Y)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
function distancia(a, b) { // Levenshtein
  const m = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return m[a.length][b.length];
}
// "Mismo nombre" = igual tras normalizar, uno contiene al otro, o solo difiere
// por una errata (≤ 2 letras en nombres de más de 8).
function mismoNombre(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return x === y;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  return Math.max(x.length, y.length) > 8 && distancia(x, y) <= 2;
}
const cruzan = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
function encimado(a, b) {
  try {
    const i = turf.intersect(turf.featureCollection([a, b]));
    return i ? turf.area(i) : 0;
  } catch { return 0; }
}

const A = [], B = [], C = [];
for (const c of ine) {
  let mejor = null;
  for (const z of inegi) {
    if (!cruzan(c.bbox, z.bbox)) continue;
    const area = encimado(c.geo, z.geo);
    if (!area) continue;
    if (!mejor || area > mejor.area) mejor = { z, area };
  }
  if (!mejor) continue;
  const { z, area } = mejor;
  const cubreIne = area / c.area;   // qué parte de la colonia del INE cae en la del INEGI
  const cubreInegi = area / z.area; // y al revés
  const fila = {
    ine: c.nombre, cp: c.cp, inegi: z.n, k: z.k, tipo: z.t, viv: z.v,
    cubreIne: +cubreIne.toFixed(2), cubreInegi: +cubreInegi.toFixed(2)
  };
  const par = c.nombre.match(/^(.*?)\s*\((.+)\)\s*$/);
  if (par && cubreIne >= 0.5) {
    const [, fuera, dentro] = par;
    // el nombre que NO es el del INEGI es el alterno
    const alterno = mismoNombre(fuera, z.n) ? dentro : mismoNombre(dentro, z.n) ? fuera : c.nombre;
    A.push({ ...fila, alterno: alterno.trim() });
  } else if (mismoNombre(c.nombre, z.n)) {
    continue; // mismo lugar, mismo nombre: nada que hacer
  } else if (cubreIne >= 0.7 && cubreInegi >= 0.7) {
    B.push(fila);
  } else if (cubreIne >= 0.7) {
    C.push(fila);
  }
}

// Puntuales (sin contorno): la zona INEGI que contiene el punto.
const P = [];
for (const p of puntuales) {
  const pt = turf.point(p.punto);
  const z = inegi.find((x) => cruzan(x.bbox, [...p.punto, ...p.punto]) && turf.booleanPointInPolygon(pt, x.geo));
  if (z && !mismoNombre(p.nombre, z.n)) P.push({ ine: p.nombre, cp: p.cp, inegi: z.n, k: z.k });
}

const orden = (a, b) => a.inegi.localeCompare(b.inegi, 'es');
const resultado = {
  generado: new Date().toISOString(),
  fuente: 'INE BGD (capa COLONIA, municipio 54) vs public/colonias_morelia.json',
  A_parentesis: A.sort(orden), B_mismo_contorno: B.sort(orden),
  C_dentro_de_otra: C.sort(orden), puntuales: P.sort(orden)
};
fs.writeFileSync(SALIDA, JSON.stringify(resultado, null, 1));
console.log(`A) nombre entre paréntesis: ${A.length}`);
for (const f of A) console.log(`   ${f.inegi}  ←  "${f.alterno}"   [INE: ${f.ine}]`);
console.log(`B) mismo contorno, otro nombre: ${B.length}`);
for (const f of B) console.log(`   ${f.inegi}  ←  "${f.ine}"  (${Math.round(f.cubreIne * 100)}%/${Math.round(f.cubreInegi * 100)}%)`);
console.log(`C) dentro de otra zona INEGI, otro nombre: ${C.length} · puntuales con otro nombre: ${P.length}`);
console.log('Detalle en ' + SALIDA);

// --- 4) lista para el buscador de la app ---------------------------------------
// A y B → "también le dicen" (el mismo lugar con otro nombre).
// C y puntuales → "aquí queda" (un fraccionamiento o etapa más chica que el
// INEGI juntó dentro de una zona más grande).
// Se DESCARTA todo nombre que ya es (o contiene, o está contenido en) el de
// OTRA colonia del INEGI: ahí el INE y el INEGI trazan distinto el límite, y
// buscar ese nombre ya lleva a la colonia correcta; agregarlo confundiría.
const normInegi = inegi.map((z) => ({ k: z.k, x: norm(z.n) }));
const chocaConOtra = (nombre, k) => {
  const y = norm(nombre);
  if (y.length < 3) return true;
  return normInegi.some((z) => z.k !== k && z.x && (z.x === y || z.x.includes(y) || y.includes(z.x)));
};
const PEQUENAS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'en']);
const bonito = (s) =>
  s.toLowerCase().replace(/\s+/g, ' ').trim().split(' ').map((w, i) =>
    /^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/.test(w) ? w.toUpperCase()
      : i > 0 && PEQUENAS.has(w) ? w
      : w.charAt(0).toUpperCase() + w.slice(1)
  ).join(' ');
const lista = [];
const vistos = new Set();
function agregar(k, alias, tipo) {
  alias = alias.replace(/[()]/g, ' ').trim();
  const z = inegi.find((x) => x.k === k);
  if (!alias || mismoNombre(alias, z.n) || chocaConOtra(alias, k)) return;
  const id = k + '|' + norm(alias);
  if (vistos.has(id)) return;
  vistos.add(id);
  lista.push({ k, alias: bonito(alias), tipo });
}
for (const f of A) for (const parte of f.ine.split(/[()]/)) agregar(f.k, parte, 'alias');
for (const f of B) agregar(f.k, f.ine, 'alias');
for (const f of [...C, ...P]) agregar(f.k, f.ine, 'incluye');
lista.sort((a, b) => a.k.localeCompare(b.k) || a.alias.localeCompare(b.alias, 'es'));
fs.writeFileSync('src/lib/nombresAlternosINE.json', JSON.stringify(lista));
const cuenta = (t) => lista.filter((x) => x.tipo === t).length;
console.log(`→ src/lib/nombresAlternosINE.json: ${cuenta('alias')} "también le dicen" + ${cuenta('incluye')} "aquí queda"`);

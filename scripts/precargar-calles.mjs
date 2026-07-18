// Precarga las calles de TODAS las colonias del catálogo en el caché
// compartido de Supabase (tabla calles_cache). Así ningún teléfono en la
// calle depende de que OpenStreetMap responda: la app encuentra su colonia
// en la nube a la primera.
//
// Correr desde la PC: node scripts/precargar-calles.mjs
// - Va despacio a propósito (pausa entre colonias) para respetar los
//   servidores de OpenStreetMap.
// - Se puede interrumpir y volver a correr: se salta lo que ya está fresco
//   en la nube (menos de 30 días).
// - Volver a correr tras cambiar la consulta en src/lib/calles-query.js.

import fs from 'node:fs';
import { armarConsulta, recortarWays } from '../src/lib/calles-query.js';

// Mismos valores públicos que usa la app (src/lib/nube.js).
const SUPABASE_URL = 'https://pxhiafunsxkdmcplwhul.supabase.co';
const SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4aGlhZnVuc3hrZG1jcGx3aHVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDgxNTAsImV4cCI6MjA5NjcyNDE1MH0.' +
  'jl7qlsobopVgg7HBFvWjSnQ8FexBEkbK6wjvku2_zxw';

const CABECERAS = {
  apikey: SUPABASE_KEY,
  Authorization: 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json'
};

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

const PAUSA_MS = 2000; // entre colonias, para no saturar a OpenStreetMap
const FRESCO_DIAS = 30; // lo ya guardado hace menos de esto no se vuelve a bajar

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Claves ya guardadas en la nube con su fecha (paginado de 1000 en 1000).
async function clavesEnNube() {
  const fechas = new Map();
  for (let desde = 0; ; desde += 1000) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/calles_cache?select=clave,actualizado`,
      { headers: { ...CABECERAS, Range: `${desde}-${desde + 999}` } }
    );
    if (!res.ok) throw new Error('Supabase respondió ' + res.status);
    const filas = await res.json();
    for (const f of filas) fechas.set(f.clave, new Date(f.actualizado).getTime());
    if (filas.length < 1000) return fechas;
  }
}

async function bajarDeOverpass(query, intento = 0) {
  const endpoint = ENDPOINTS[intento % ENDPOINTS.length];
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Cortesía de OpenStreetMap: identificarse. Sin esto responden 406.
      'User-Agent': 'GeoBrigada/1.0 (precarga de calles de Morelia; slasherbaird@gmail.com)'
    },
    body: 'data=' + encodeURIComponent(query)
  });
  if (res.status === 429 || res.status === 504) {
    if (intento >= 8) throw new Error('Overpass respondió ' + res.status + ' (8 intentos)');
    const espera = 15000 * (intento + 1); // espera creciente: 15 s, 30 s...
    console.log(`    saturado (${res.status}), esperando ${espera / 1000} s...`);
    await dormir(espera);
    return bajarDeOverpass(query, intento + 1);
  }
  if (!res.ok) throw new Error('Overpass respondió ' + res.status);
  const json = await res.json();
  return json.elements.filter((e) => e.type === 'way' && e.geometry);
}

async function subirANube(clave, ways) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/calles_cache`, {
    method: 'POST',
    headers: { ...CABECERAS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ clave, ways, actualizado: new Date().toISOString() })
  });
  if (!res.ok) throw new Error('Supabase respondió ' + res.status + ' al guardar');
}

const { colonias, polys } = JSON.parse(
  fs.readFileSync('public/colonias_morelia.json', 'utf8')
);

console.log(`Catálogo: ${colonias.length} colonias. Revisando la nube...`);
const enNube = await clavesEnNube();
console.log(`Ya en la nube: ${enNube.size} entradas.`);

let hechas = 0, saltadas = 0, fallidas = 0, bytes = 0;
const limiteFresco = Date.now() - FRESCO_DIAS * 86400000;

for (let i = 0; i < colonias.length; i++) {
  const c = colonias[i];
  const rings = polys[c.k];
  if (!rings) {
    console.log(`[${i + 1}/${colonias.length}] ${c.n} — SIN POLÍGONO, se salta`);
    continue;
  }
  const { query, clave } = armarConsulta(rings);
  if ((enNube.get(clave) || 0) > limiteFresco) {
    saltadas++;
    continue;
  }
  try {
    const ways = recortarWays(await bajarDeOverpass(query));
    await subirANube(clave, ways);
    const kb = Math.round(JSON.stringify(ways).length / 1024);
    bytes += kb * 1024;
    hechas++;
    console.log(`[${i + 1}/${colonias.length}] ${c.n} — ${ways.length} calles, ${kb} KB`);
  } catch (err) {
    fallidas++;
    console.log(`[${i + 1}/${colonias.length}] ${c.n} — FALLÓ: ${err.message}`);
  }
  await dormir(PAUSA_MS);
}

console.log(
  `\nListo: ${hechas} descargadas (${Math.round(bytes / 1048576)} MB), ` +
    `${saltadas} ya estaban frescas, ${fallidas} fallaron.` +
    (fallidas ? ' Vuelve a correr el script para reintentar las fallidas.' : '')
);

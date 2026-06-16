// Catálogo local de colonias de Morelia (generado por scripts/build-colonias.mjs).
// Fuente: INEGI DCAH 2023 — límites oficiales delimitados por el IMPLAN de Morelia.

import { pointInAnyRing } from './geo.js';

let datos = null;

export async function cargarCatalogo() {
  if (datos) return datos;
  const res = await fetch(import.meta.env.BASE_URL + 'colonias_morelia.json');
  if (!res.ok) throw new Error('No se pudo cargar el catálogo de colonias.');
  datos = await res.json();
  return datos;
}

// Quita acentos y pasa a minúsculas para comparar.
const normalizar = (s) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Búsqueda por nombre, sin distinguir acentos ni mayúsculas.
export async function buscarColonias(texto) {
  const { colonias } = await cargarCatalogo();
  const q = normalizar(texto.trim());
  if (!q) return [];
  const empiezan = [];
  const contienen = [];
  for (const c of colonias) {
    const n = normalizar(c.n);
    if (n.startsWith(q)) empiezan.push(c);
    else if (n.includes(q)) contienen.push(c);
  }
  return [...empiezan, ...contienen].slice(0, 20);
}

// Anillos [lat,lng] de la colonia, por su clave geoestadística (CVEGEO).
export async function ringsPorClave(k) {
  const { polys } = await cargarCatalogo();
  return polys[k] || null;
}

// ¿Qué colonia contiene este punto? Devuelve { n, k, t, cp, rings } o null.
// Permite seleccionar una colonia tocando el mapa, sin saber su nombre.
export async function coloniaEnPunto(lat, lng) {
  const { colonias, polys } = await cargarCatalogo();
  const p = [lat, lng];
  for (const c of colonias) {
    const rings = polys[c.k];
    if (rings && pointInAnyRing(p, rings)) {
      return { ...c, rings };
    }
  }
  return null;
}

// Catálogo local de colonias de Morelia (generado por scripts/build-colonias.mjs).
// Fuente: INEGI DCAH 2023 — límites oficiales delimitados por el IMPLAN de Morelia.
//
// También resuelve las SECCIONES ELECTORALES del INE (public/secciones_morelia.json,
// scripts/build-secciones.mjs): mismo formato, clave "S" + número (S2881). Así
// una sección se busca, se planea, se manda en un link de brigadista y sale en
// Cobertura/Historial igual que una colonia, sin que cada vista tenga que
// saber la diferencia. Ese archivo solo se baja cuando hace falta (al buscar
// un número o abrir una sección), no al abrir la app.

import { pointInAnyRing } from './geo.js';

let datos = null;
let datosSecciones = null;

export async function cargarCatalogo() {
  if (datos) return datos;
  const res = await fetch(import.meta.env.BASE_URL + 'colonias_morelia.json');
  if (!res.ok) throw new Error('No se pudo cargar el catálogo de colonias.');
  datos = await res.json();
  return datos;
}

export async function cargarSecciones() {
  if (datosSecciones) return datosSecciones;
  const res = await fetch(import.meta.env.BASE_URL + 'secciones_morelia.json');
  if (!res.ok) throw new Error('No se pudo cargar el catálogo de secciones.');
  datosSecciones = await res.json();
  return datosSecciones;
}

const esSeccion = (k) => typeof k === 'string' && /^S\d+$/.test(k);
const catalogoDe = (k) => (esSeccion(k) ? cargarSecciones() : cargarCatalogo());

// Quita acentos y pasa a minúsculas para comparar.
const normalizar = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Búsqueda por nombre, sin distinguir acentos ni mayúsculas. Si lo escrito es
// un número ("2881" o "sección 2881"), busca secciones electorales que empiecen
// con ese número.
export async function buscarColonias(texto) {
  const q = normalizar(texto.trim());
  if (!q) return [];
  const numero = q.match(/^(?:secc?(?:ion)?\.?\s*)?(\d+)$/);
  if (numero) {
    const { colonias: secciones } = await cargarSecciones();
    return secciones.filter((s) => String(s.s).startsWith(numero[1])).slice(0, 20);
  }
  const { colonias } = await cargarCatalogo();
  const empiezan = [];
  const contienen = [];
  for (const c of colonias) {
    const n = normalizar(c.n);
    if (n.startsWith(q)) empiezan.push(c);
    else if (n.includes(q)) contienen.push(c);
  }
  return [...empiezan, ...contienen].slice(0, 20);
}

// Todas las colonias del catálogo ({ k, n, t, cp, v }), ordenadas por nombre.
export async function todasLasColonias() {
  const { colonias } = await cargarCatalogo();
  return colonias;
}

// Anillos [lat,lng] de la colonia (o sección), por su clave.
export async function ringsPorClave(k) {
  const { polys } = await catalogoDe(k);
  return polys[k] || null;
}

// Datos de una colonia (o sección) por su clave (incluye viviendas "v"), o null.
export async function coloniaPorClave(k) {
  const { colonias } = await catalogoDe(k);
  return colonias.find((c) => c.k === k) || null;
}

// ¿Qué colonia contiene este punto? Devuelve { n, k, t, cp, rings } o null.
// Permite seleccionar una colonia tocando el mapa, sin saber su nombre.
// Solo colonias: lo usa también el autollenado de bardas nuevas.
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

// ¿Qué sección electoral contiene este punto? { s, dl, df, ... rings } o null.
export async function seccionEnPunto(lat, lng) {
  const { colonias: secciones, polys } = await cargarSecciones();
  const p = [lat, lng];
  for (const s of secciones) {
    const rings = polys[s.k];
    if (rings && pointInAnyRing(p, rings)) return { ...s, rings };
  }
  return null;
}

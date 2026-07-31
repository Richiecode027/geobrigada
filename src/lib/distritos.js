// Distritos electorales LOCALES que cubren Morelia (10, 11, 16 y 17), con sus
// límites oficiales del INE. Lo genera scripts/build-distritos.mjs.
//
// Antes el distrito se adivinaba a partir de las bardas ya capturadas; con
// esto se sabe de verdad: es el mismo trazo que usa la autoridad electoral.

import { pointInAnyRing } from './geo.js';

let catalogo = null;

export async function cargarDistritos() {
  if (catalogo) return catalogo;
  const res = await fetch(import.meta.env.BASE_URL + 'distritos_morelia.json');
  if (!res.ok) throw new Error('No se pudo cargar el catálogo de distritos.');
  catalogo = await res.json();
  return catalogo;
}

// Número de distrito local en el que cae el punto, o null si queda fuera del
// municipio de Morelia (el catálogo solo cubre Morelia y sus tenencias).
export async function distritoEnPunto(lat, lng) {
  const { distritos } = await cargarDistritos();
  for (const z of distritos) {
    if (pointInAnyRing([lat, lng], z.rings)) return z.d;
  }
  return null;
}

// Color por distrito, para pintar los límites en el mapa. Son tonos apagados
// a propósito: los pines de bardas tienen que seguir siendo lo que resalta.
export const COLOR_DISTRITO = {
  10: '#6b8fd4',
  11: '#59a88a',
  16: '#c98bbd',
  17: '#d1a05e'
};

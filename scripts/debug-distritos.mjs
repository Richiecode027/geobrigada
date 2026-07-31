// Contrasta el distrito OFICIAL (public/distritos_morelia.json) contra el que
// venía escrito a mano en el Excel de bardas. Sirve para saber en cuáles hay
// que fiarse del INE y cuáles se capturaron mal.
//
// Uso: node scripts/debug-distritos.mjs

import fs from 'node:fs';
import { pointInAnyRing } from '../src/lib/geo.js';

const cat = JSON.parse(fs.readFileSync('public/distritos_morelia.json', 'utf8'));
const bardas = JSON.parse(fs.readFileSync('public/bardas.json', 'utf8')).bardas;

const distritoDe = (lat, lng) => {
  for (const z of cat.distritos) if (pointInAnyRing([lat, lng], z.rings)) return z.d;
  return null;
};

const conCoords = bardas.filter((b) => b.lat != null);
const conDato = conCoords.filter((b) => b.distrito);

let iguales = 0, distintos = 0, fuera = 0;
const detalle = [];
for (const b of conDato) {
  const oficial = distritoDe(b.lat, b.lng);
  if (oficial == null) {
    fuera++;
    detalle.push(`  fuera del municipio · barda ${b.id} "${b.direccion}" (${b.colonia})`);
    continue;
  }
  if (String(oficial) === String(b.distrito)) iguales++;
  else {
    distintos++;
    detalle.push(`  barda ${b.id} "${b.direccion}" (${b.colonia}) · Excel: ${b.distrito} · INE: ${oficial}`);
  }
}

console.log(`Bardas con coordenadas: ${conCoords.length} · con distrito escrito: ${conDato.length}`);
console.log(`  coinciden con el INE: ${iguales}`);
console.log(`  discrepan:            ${distintos}`);
console.log(`  caen fuera de Morelia:${fuera}`);
if (detalle.length) {
  console.log('\nDetalle:');
  detalle.forEach((d) => console.log(d));
}

// Cobertura: ¿a cuántas bardas les puede poner distrito el catálogo oficial?
const cubiertas = conCoords.filter((b) => distritoDe(b.lat, b.lng) != null).length;
console.log(`\nCobertura: el catálogo oficial ubica ${cubiertas} de ${conCoords.length} bardas con coordenadas.`);

const porDistrito = new Map();
for (const b of conCoords) {
  const d = distritoDe(b.lat, b.lng);
  const k = d == null ? 'fuera' : d;
  porDistrito.set(k, (porDistrito.get(k) || 0) + 1);
}
console.log('Reparto según el INE:',
  [...porDistrito].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([k, v]) => `${k}: ${v}`).join(' · '));

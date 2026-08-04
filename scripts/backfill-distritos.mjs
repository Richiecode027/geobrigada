// Rellena el DISTRITO de las bardas agregadas desde el teléfono ANTES de que
// existiera la detección automática por el trazo oficial del INE (jul 2026).
// Esas filas se quedaron con distrito=null para siempre, porque nada las
// vuelve a tocar después de creadas.
//
// Solo escribe en filas donde distrito es null: nunca pisa un valor que ya
// esté puesto. Usa el mismo cálculo (mismo archivo distritos_morelia.json)
// que ya usa la app para las bardas nuevas de hoy.
//
// Con --dry solo enseña qué haría, sin tocar la nube. Sin esa bandera, sube.
//
// Uso:
//   node scripts/backfill-distritos.mjs [--dry]

import fs from 'node:fs';
import { pointInAnyRing } from '../src/lib/geo.js';

const soloVer = process.argv.includes('--dry');

const SUPABASE_URL = 'https://pxhiafunsxkdmcplwhul.supabase.co';
const SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4aGlhZnVuc3hrZG1jcGx3aHVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDgxNTAsImV4cCI6MjA5NjcyNDE1MH0.' +
  'jl7qlsobopVgg7HBFvWjSnQ8FexBEkbK6wjvku2_zxw';

const cabeceras = {
  apikey: SUPABASE_KEY,
  Authorization: 'Bearer ' + SUPABASE_KEY,
  'Content-Type': 'application/json'
};

console.log('Leyendo distritos_morelia.json…');
const { distritos } = JSON.parse(fs.readFileSync('public/distritos_morelia.json', 'utf8'));

console.log('Buscando bardas_nuevas sin distrito…');
const res = await fetch(
  `${SUPABASE_URL}/rest/v1/bardas_nuevas?select=id,lat,lng&distrito=is.null&borrado=eq.false`,
  { headers: cabeceras }
);
if (!res.ok) throw new Error('No se pudo leer bardas_nuevas: ' + res.status + ' ' + (await res.text()));
const filas = await res.json();
console.log(`${filas.length} bardas sin distrito.\n`);

let resueltas = 0, sinDistrito = 0, fallidas = 0;
for (const b of filas) {
  let distrito = null;
  for (const z of distritos) {
    if (pointInAnyRing([b.lat, b.lng], z.rings)) {
      distrito = String(z.d);
      break;
    }
  }
  if (!distrito) {
    sinDistrito++;
    console.log(`  ⚠ ${b.id}: (${b.lat}, ${b.lng}) queda fuera de los 4 distritos — se deja como está.`);
    continue;
  }

  if (soloVer) {
    console.log(`  ${b.id}: distrito ${distrito}`);
    resueltas++;
    continue;
  }

  const up = await fetch(`${SUPABASE_URL}/rest/v1/bardas_nuevas?id=eq.${encodeURIComponent(b.id)}`, {
    method: 'PATCH',
    headers: { ...cabeceras, Prefer: 'return=minimal' },
    body: JSON.stringify({ distrito })
  });
  if (up.ok) {
    resueltas++;
  } else {
    fallidas++;
    console.log(`  ❌ ${b.id}: error ${up.status} al guardar distrito ${distrito}`);
  }
}

console.log('\n--------------------------------------------------');
if (soloVer) {
  console.log(`(--dry: no se subió nada) Se calcularían ${resueltas} distritos, ${sinDistrito} quedarían sin resolver.`);
} else {
  console.log(`Actualizadas: ${resueltas} · sin resolver (fuera de los 4 distritos): ${sinDistrito} · fallidas: ${fallidas}`);
}

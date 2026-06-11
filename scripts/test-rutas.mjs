// Prueba rápida del algoritmo de reparto y recorrido sobre una retícula
// sintética de calles (como una colonia cuadriculada de Morelia):
//   node scripts/test-rutas.mjs
// Verifica: zonas conectadas, balance de km y saltos del recorrido.

import { partition, orderRoute, buildAdjacency, puntoDeEncuentro } from '../src/lib/partition.js';
import { haversine, polylineLength } from '../src/lib/geo.js';

// Retícula de 8x8 esquinas (~110 m por cuadra), calles horizontales y verticales.
const N = 8;
const lat0 = 19.7, lng0 = -101.19, paso = 0.001;
const units = [];
let id = 0;
function nodo(f, c) {
  return [lat0 + f * paso, lng0 + c * paso];
}
for (let f = 0; f < N; f++) {
  for (let c = 0; c < N; c++) {
    if (c + 1 < N) {
      const coords = [nodo(f, c), nodo(f, c + 1)];
      units.push({ id: id++, name: `H${f}-${c}`, coords, length: polylineLength(coords), mid: [(coords[0][0] + coords[1][0]) / 2, (coords[0][1] + coords[1][1]) / 2] });
    }
    if (f + 1 < N) {
      const coords = [nodo(f, c), nodo(f + 1, c)];
      units.push({ id: id++, name: `V${f}-${c}`, coords, length: polylineLength(coords), mid: [(coords[0][0] + coords[1][0]) / 2, (coords[0][1] + coords[1][1]) / 2] });
    }
  }
}

for (const k of [2, 3, 4]) {
  const grupos = partition(units, k);
  const inicio = puntoDeEncuentro(units);

  // 1. Conectividad de cada zona
  let zonasConectadas = true;
  for (const g of grupos) {
    const ady = buildAdjacency(g);
    const visto = new Set([0]);
    const cola = [0];
    while (cola.length) {
      for (const v of ady[cola.pop()]) {
        if (!visto.has(v)) { visto.add(v); cola.push(v); }
      }
    }
    if (visto.size !== g.length) zonasConectadas = false;
  }

  // 2. Balance
  const cargas = grupos.map((g) => g.reduce((s, u) => s + u.length, 0) / 1000);
  const objetivo = cargas.reduce((a, b) => a + b, 0) / k;
  const desvMax = Math.max(...cargas.map((c) => Math.abs(c - objetivo) / objetivo));

  // 3. Saltos del recorrido (huecos a pie entre tramo y tramo)
  let saltoMax = 0, saltosLargos = 0, saltoTotal = 0;
  for (const g of grupos) {
    const ruta = orderRoute(g, inicio);
    for (let i = 1; i < ruta.length; i++) {
      const fin = ruta[i - 1].coords[ruta[i - 1].coords.length - 1];
      const ini = ruta[i].coords[0];
      const d = haversine(fin, ini);
      saltoTotal += d;
      if (d > saltoMax) saltoMax = d;
      if (d > 250) saltosLargos++;
    }
  }

  console.log(
    `k=${k} | zonas conectadas: ${zonasConectadas ? 'SÍ' : 'NO ✗'} | ` +
      `cargas km: [${cargas.map((c) => c.toFixed(1)).join(', ')}] (desv. máx ${(desvMax * 100).toFixed(0)}%) | ` +
      `salto máx ${Math.round(saltoMax)} m, saltos >250m: ${saltosLargos}, total saltos ${Math.round(saltoTotal)} m`
  );
}

// Determinismo: dos corridas idénticas deben dar el mismo resultado.
const a = JSON.stringify(partition(units, 3).map((g) => g.map((u) => u.id)));
const b = JSON.stringify(partition(units, 3).map((g) => g.map((u) => u.id)));
console.log('determinista:', a === b ? 'SÍ' : 'NO ✗');

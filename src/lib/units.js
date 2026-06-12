// Convierte las calles de OSM en "unidades" de reparto. La unidad es la
// CUADRA COMPLETA (de esquina a esquina): así una calle nunca cambia de
// equipo a media cuadra y cada brigada sabe exactamente dónde termina lo
// suyo. (Antes se partía cada ~180 m y los cortes caían entre casas.)

import { haversine, pointInAnyRing, distanciaABorde, ringsBounds } from './geo.js';
import { buildAdjacency } from './partition.js';

// Migajas: piezas de calle aisladas más cortas que esto (restos del recorte
// en el límite de la colonia) se descartan para no ensuciar las rutas.
const MIN_COMPONENTE_M = 60;
// Las calles que corren SOBRE el límite de la colonia también se reparten:
// sus puntos pueden caer unos metros afuera del polígono oficial.
const TOL_BORDE_M = 20;
// Un tramo recto largo puede cruzar la colonia sin tener puntos intermedios;
// se agregan puntos cada ~25 m para que el recorte no lo pierda.
const PASO_DENSIFICAR_M = 25;

// Misma precisión que usa el grafo de conectividad (partition.js).
const claveNodo = (lat, lon) => lat.toFixed(6) + ',' + lon.toFixed(6);

function densificar(coords) {
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const d = haversine(a, b);
    if (d > PASO_DENSIFICAR_M) {
      const n = Math.ceil(d / PASO_DENSIFICAR_M);
      for (let j = 1; j < n; j++) {
        out.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
      }
    }
    out.push(b);
  }
  return out;
}

export function buildUnits(ways, rings) {
  const units = [];
  let id = 0;

  // Prefiltro rápido por caja envolvente: evita calcular la distancia al borde
  // (que es costosa) para puntos claramente lejos de la colonia.
  const [[minLat, minLng], [maxLat, maxLng]] = ringsBounds(rings);
  const M = 0.0004; // ~40 m de margen
  function dentro(p) {
    if (p[0] < minLat - M || p[0] > maxLat + M || p[1] < minLng - M || p[1] > maxLng + M) {
      return false;
    }
    return pointInAnyRing(p, rings) || distanciaABorde(p, rings) <= TOL_BORDE_M;
  }

  // Una corrida de puntos dentro del límite = una unidad completa (no se
  // parte por longitud: solo en esquinas y en el borde de la colonia).
  function agregarCorrida(corrida, name) {
    if (corrida.length < 2) return;
    let len = 0;
    for (let i = 1; i < corrida.length; i++) len += haversine(corrida[i - 1], corrida[i]);
    if (len <= 5) return;
    const mid = corrida[Math.floor(corrida.length / 2)];
    units.push({ id: id++, name, coords: corrida, length: len, mid });
  }

  // 1) Esquinas: nodos que pertenecen a más de una calle (cruces reales).
  //    Se cuenta con TODAS las calles del área (también las de afuera del
  //    límite): una esquina con una calle vecina sigue siendo esquina.
  const callesPorNodo = new Map();
  for (const w of ways) {
    if (!w.geometry) continue;
    const visto = new Set();
    for (const g of w.geometry) {
      const k = claveNodo(g.lat, g.lon);
      if (visto.has(k)) continue; // una calle cuenta una sola vez por nodo
      visto.add(k);
      callesPorNodo.set(k, (callesPorNodo.get(k) || 0) + 1);
    }
  }

  for (const w of ways) {
    const crudos = w.geometry.map((g) => [g.lat, g.lon]);
    if (crudos.length < 2) continue;
    const name = (w.tags && w.tags.name) || 'Calle sin nombre';

    // 2) Parte la calle en cuadras: corta en cada esquina interior.
    const cuadras = [];
    let cur = [crudos[0]];
    for (let i = 1; i < crudos.length; i++) {
      cur.push(crudos[i]);
      const esInterior = i < crudos.length - 1;
      if (esInterior && (callesPorNodo.get(claveNodo(crudos[i][0], crudos[i][1])) || 0) >= 2) {
        cuadras.push(cur);
        cur = [crudos[i]];
      }
    }
    if (cur.length >= 2) cuadras.push(cur);

    // 3) Recorta cada cuadra al límite de la colonia, punto por punto.
    for (const cuadra of cuadras) {
      const coords = densificar(cuadra);
      let corrida = [];
      for (const p of coords) {
        if (dentro(p)) {
          corrida.push(p);
        } else {
          agregarCorrida(corrida, name);
          corrida = [];
        }
      }
      agregarCorrida(corrida, name);
    }
  }

  // Limpia migajas: componentes aisladas minúsculas que deja el recorte.
  const ady = buildAdjacency(units);
  const visto = new Array(units.length).fill(false);
  const conservar = new Array(units.length).fill(true);
  for (let i = 0; i < units.length; i++) {
    if (visto[i]) continue;
    const comp = [i];
    visto[i] = true;
    for (let p = 0; p < comp.length; p++) {
      for (const v of ady[comp[p]]) {
        if (!visto[v]) {
          visto[v] = true;
          comp.push(v);
        }
      }
    }
    const total = comp.reduce((s, j) => s + units[j].length, 0);
    if (total < MIN_COMPONENTE_M) {
      for (const j of comp) conservar[j] = false;
    }
  }
  return units.filter((_, i) => conservar[i]);
}

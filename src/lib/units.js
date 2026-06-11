// Convierte las calles de OSM en "unidades": tramos de calle de ~180 m máximo.
// Las unidades son la pieza que se reparte entre equipos; tramos cortos
// permiten balancear mejor la carga de cada equipo.

import { haversine, pointInAnyRing, distanciaABorde, ringsBounds } from './geo.js';
import { buildAdjacency } from './partition.js';

const MAX_UNIT_METERS = 180;
// Migajas: piezas de calle aisladas más cortas que esto (restos del recorte
// en el límite de la colonia) se descartan para no ensuciar las rutas.
const MIN_COMPONENTE_M = 60;
// Las calles que corren SOBRE el límite de la colonia también se reparten:
// sus puntos pueden caer unos metros afuera del polígono oficial.
const TOL_BORDE_M = 20;
// Un tramo recto largo puede cruzar la colonia sin tener puntos intermedios;
// se agregan puntos cada ~25 m para que el recorte no lo pierda.
const PASO_DENSIFICAR_M = 25;

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

  // Parte una corrida de puntos (toda dentro del límite) en unidades de ~180 m.
  function agregarCorrida(corrida, name) {
    let cur = [corrida[0]];
    let len = 0;
    for (let i = 1; i < corrida.length; i++) {
      const d = haversine(corrida[i - 1], corrida[i]);
      cur.push(corrida[i]);
      len += d;
      const esUltimo = i === corrida.length - 1;
      if (len >= MAX_UNIT_METERS || esUltimo) {
        if (cur.length >= 2 && len > 5) {
          const mid = cur[Math.floor(cur.length / 2)];
          units.push({ id: id++, name, coords: cur, length: len, mid });
        }
        cur = [corrida[i]];
        len = 0;
      }
    }
  }

  for (const w of ways) {
    const crudos = w.geometry.map((g) => [g.lat, g.lon]);
    if (crudos.length < 2) continue;
    const coords = densificar(crudos);
    const name = (w.tags && w.tags.name) || 'Calle sin nombre';

    // Recorte punto por punto: solo se conservan corridas de puntos
    // consecutivos dentro del límite (o sobre él, con tolerancia pequeña).
    let corrida = [];
    for (const p of coords) {
      if (dentro(p)) {
        corrida.push(p);
      } else {
        if (corrida.length >= 2) agregarCorrida(corrida, name);
        corrida = [];
      }
    }
    if (corrida.length >= 2) agregarCorrida(corrida, name);
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

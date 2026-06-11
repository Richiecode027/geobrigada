// Convierte las calles de OSM en "unidades": tramos de calle de ~180 m máximo.
// Las unidades son la pieza que se reparte entre equipos; tramos cortos
// permiten balancear mejor la carga de cada equipo.

import { haversine, pointInAnyRing } from './geo.js';
import { buildAdjacency } from './partition.js';

const MAX_UNIT_METERS = 180;
// Migajas: piezas de calle aisladas más cortas que esto (restos del recorte
// en el límite de la colonia) se descartan para no ensuciar las rutas.
const MIN_COMPONENTE_M = 60;

export function buildUnits(ways, rings) {
  const units = [];
  let id = 0;

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
    const coords = w.geometry.map((g) => [g.lat, g.lon]);
    if (coords.length < 2) continue;
    const name = (w.tags && w.tags.name) || 'Calle sin nombre';

    // Recorte punto por punto: solo se conservan corridas de puntos
    // consecutivos DENTRO del límite de la colonia, ni más ni menos.
    let corrida = [];
    for (const p of coords) {
      if (pointInAnyRing(p, rings)) {
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

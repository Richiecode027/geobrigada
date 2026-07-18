// Consulta de calles a Overpass: la arman IGUAL la app (src/api/overpass.js)
// y el script de precarga (scripts/precargar-calles.mjs). Vive aparte para que
// la clave del caché sea idéntica en los dos lados — si cambia algo aquí hay
// que volver a correr la precarga.

import { ringsBounds } from './geo.js';

// Tipos de vialidad que un brigadista recorre a pie repartiendo material.
// Incluye privadas/callejones (service) y andadores (footway), pero excluye
// pasillos de estacionamiento y entradas de cochera.
export const HIGHWAY_REGEX =
  '^(primary|secondary|tertiary|residential|living_street|unclassified|pedestrian|service|footway)$';
export const SERVICE_EXCLUIR = 'parking_aisle|driveway|drive-through|emergency_access';

const CACHE_PREFIJO = 'geobrigada_calles_';

// Consulta por caja envolvente (con margen) y la clave de caché derivada.
// Se pide por caja en lugar de por polígono: Overpass solo regresa calles con
// NODOS dentro del polígono y eso pierde las que cruzan la colonia o corren
// sobre su límite. El recorte fino lo hace la app localmente (units.js).
export function armarConsulta(rings) {
  const [[s, w], [n, e]] = ringsBounds(rings);
  const m = 0.001; // ~100 m de margen
  const bbox = `${(s - m).toFixed(6)},${(w - m).toFixed(6)},${(n + m).toFixed(6)},${(e + m).toFixed(6)}`;
  const query =
    `[out:json][timeout:50];` +
    `way["highway"~"${HIGHWAY_REGEX}"]["service"!~"${SERVICE_EXCLUIR}"](${bbox});` +
    `out geom;`;
  let h = 0;
  for (let i = 0; i < query.length; i++) h = (h * 31 + query.charCodeAt(i)) >>> 0;
  return { query, clave: CACHE_PREFIJO + h.toString(36) };
}

// La app solo usa la geometría y el nombre de cada calle (units.js); el resto
// de lo que manda Overpass (ids, bounds, más etiquetas) se descarta para que
// el caché pese ~3 veces menos.
export function recortarWays(ways) {
  return ways.map((w) => ({
    type: 'way',
    tags: w.tags && w.tags.name ? { name: w.tags.name } : {},
    geometry: w.geometry
  }));
}

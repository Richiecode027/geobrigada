// Obtiene de Overpass (OpenStreetMap) todas las calles dentro de la colonia.

import { ringsBounds } from '../lib/geo.js';

// Tipos de vialidad que un brigadista recorre a pie repartiendo material.
// Incluye privadas/callejones (service) y andadores (footway), pero excluye
// pasillos de estacionamiento y entradas de cochera.
const HIGHWAY_REGEX =
  '^(primary|secondary|tertiary|residential|living_street|unclassified|pedestrian|service|footway)$';
const SERVICE_EXCLUIR = 'parking_aisle|driveway|drive-through|emergency_access';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

// Si un espejo se cuelga sin responder, se corta a los 25 s y se pasa al
// siguiente; sin esto la app se queda "calculando rutas" para siempre.
const ESPERA_MS = 25000;

async function fetchConLimite(url, opts) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), ESPERA_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(tid);
  }
}

// Caché local de calles por colonia (7 días): regenerar rutas con otro número
// de equipos es instantáneo y no se satura a los servidores de OpenStreetMap.
const CACHE_PREFIJO = 'geobrigada_calles_';
const CACHE_DIAS = 7;

function claveCache(query) {
  let h = 0;
  for (let i = 0; i < query.length; i++) h = (h * 31 + query.charCodeAt(i)) >>> 0;
  return CACHE_PREFIJO + h.toString(36);
}

function leerCache(clave) {
  try {
    const raw = localStorage.getItem(clave);
    if (!raw) return null;
    const { t, ways } = JSON.parse(raw);
    if (Date.now() - t > CACHE_DIAS * 86400000) return null;
    return ways;
  } catch {
    return null;
  }
}

function guardarCache(clave, ways) {
  try {
    localStorage.setItem(clave, JSON.stringify({ t: Date.now(), ways }));
  } catch {
    // sin espacio: se limpia el caché viejo y se reintenta una vez
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(CACHE_PREFIJO)) localStorage.removeItem(k);
      }
      localStorage.setItem(clave, JSON.stringify({ t: Date.now(), ways }));
    } catch {
      /* el caché es opcional */
    }
  }
}

export async function obtenerCalles(rings) {
  // Se pide por caja envolvente (con margen) en lugar de por polígono:
  // Overpass solo regresa calles con NODOS dentro del polígono, y eso
  // pierde calles que cruzan la colonia o corren sobre su límite.
  // El recorte fino punto por punto lo hace la app localmente (units.js).
  const [[s, w], [n, e]] = ringsBounds(rings);
  const m = 0.001; // ~100 m de margen
  const bbox = `${(s - m).toFixed(6)},${(w - m).toFixed(6)},${(n + m).toFixed(6)},${(e + m).toFixed(6)}`;
  const query =
    `[out:json][timeout:50];` +
    `way["highway"~"${HIGHWAY_REGEX}"]["service"!~"${SERVICE_EXCLUIR}"](${bbox});` +
    `out geom;`;

  const clave = claveCache(query);
  const enCache = leerCache(clave);
  if (enCache) return enCache;

  let lastErr = null;
  // Dos vueltas a la lista de espejos: si todos fallan a la primera (suele
  // ser saturación pasajera), se reintenta una vez más antes de rendirse.
  for (const endpoint of [...ENDPOINTS, ...ENDPOINTS]) {
    try {
      const res = await fetchConLimite(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      });
      if (!res.ok) throw new Error('Overpass respondió ' + res.status);
      const json = await res.json();
      const ways = json.elements.filter((e) => e.type === 'way' && e.geometry);
      guardarCache(clave, ways);
      return ways;
    } catch (err) {
      lastErr = err; // intenta el siguiente espejo
    }
  }
  throw new Error(
    'Los servidores de OpenStreetMap están saturados en este momento. ' +
      'Espera un minuto y vuelve a intentar. (' + (lastErr ? lastErr.message : '') + ')'
  );
}

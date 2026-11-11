// Obtiene de Overpass (OpenStreetMap) todas las calles dentro de la colonia.
// Orden de búsqueda: caché del teléfono → caché compartido en la nube →
// servidores de OpenStreetMap (y lo encontrado se guarda en los dos cachés).
// Último salvavidas si todo falla: caché vencido (local o nube) — calles de
// hace un mes son mejor que no poder trabajar en la calle.
// La nube se precarga con las 934 colonias: scripts/precargar-calles.mjs.

import { armarConsulta, recortarWays } from '../lib/calles-query.js';
import { leerCallesNube, guardarCallesNube } from '../lib/nube.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  // Espejo de VK (lista oficial de espejos en wiki.openstreetmap.org). Se
  // agregó en nov 2026: los otros tres estaban caídos o colgados a la vez.
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

// Si un espejo se cuelga sin responder, se corta y se pasa al siguiente; sin
// esto la app se queda "calculando rutas" para siempre. 45 s (antes 25): el
// espejo de VK, que en nov 2026 era el único que respondía, tarda 17-40 s en
// una colonia normal, y con 25 s se cortaba justo antes de contestar.
const ESPERA_MS = 45000;

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
const CACHE_DIAS = 7;

function leerCache(clave, aceptarVencido = false) {
  try {
    const raw = localStorage.getItem(clave);
    if (!raw) return null;
    const { t, ways } = JSON.parse(raw);
    if (!aceptarVencido && Date.now() - t > CACHE_DIAS * 86400000) return null;
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
        if (k.startsWith('geobrigada_calles_')) localStorage.removeItem(k);
      }
      localStorage.setItem(clave, JSON.stringify({ t: Date.now(), ways }));
    } catch {
      /* el caché es opcional */
    }
  }
}

// Calles de VARIAS colonias juntas: se piden de una en una (así cada una sale
// del caché de la nube, que está guardado por colonia; pedir una sola caja que
// las cubra a todas sería una consulta enorme y sin caché) y se juntan
// quitando las repetidas — una calle del límite entre dos colonias viene en
// las dos. El orden de `partes` decide el orden del resultado: debe ser el
// mismo en Planear y en el teléfono del brigadista.
export async function obtenerCallesDePartes(partes) {
  if (partes.length === 1) return obtenerCalles(partes[0]);
  const vistas = new Set();
  const todas = [];
  for (const rings of partes) {
    for (const w of await obtenerCalles(rings)) {
      const firma = w.geometry.map((p) => p.lat.toFixed(6) + ',' + p.lon.toFixed(6)).join(';');
      if (vistas.has(firma)) continue;
      vistas.add(firma);
      todas.push(w);
    }
  }
  return todas;
}

export async function obtenerCalles(rings) {
  const { query, clave } = armarConsulta(rings);

  const enCache = leerCache(clave);
  if (enCache) return enCache;

  // Caché compartido: si otro teléfono (o la precarga) ya bajó esta colonia,
  // se toma de la nube sin molestar a OpenStreetMap.
  const deNube = await leerCallesNube(clave);
  if (deNube) {
    guardarCache(clave, deNube);
    return deNube;
  }

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
      const ways = recortarWays(
        json.elements.filter((e) => e.type === 'way' && e.geometry)
      );
      guardarCache(clave, ways);
      guardarCallesNube(clave, ways); // comparte con los demás teléfonos
      return ways;
    } catch (err) {
      lastErr = err; // intenta el siguiente espejo
    }
  }

  // Salvavidas: caché vencido del teléfono, o copia vieja de la nube.
  const vencido = leerCache(clave, true);
  if (vencido) return vencido;
  const nubeVieja = await leerCallesNube(clave, null); // sin límite de fecha
  if (nubeVieja) {
    guardarCache(clave, nubeVieja);
    return nubeVieja;
  }

  throw new Error(
    'Los servidores de OpenStreetMap están saturados en este momento. ' +
      'Espera un minuto y vuelve a intentar. (' + (lastErr ? lastErr.message : '') + ')'
  );
}

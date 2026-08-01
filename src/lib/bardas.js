// Lógica de la fase de BARDAS: qué bardas faltan por visitar y en qué orden
// conviene recorrerlas.
//
// Ojo: esto NO es el mismo problema que repartir folletos. Ahí hay que caminar
// TODAS las calles de una colonia (cartero chino, ver partition.js); aquí hay
// que llegar a un puñado de PUNTOS sueltos, que además pueden estar en colonias
// distintas. Por eso el orden se arma con "vecino más cercano" desde donde
// esté parado el equipo.

import { haversine } from './geo.js';

let catalogo = null;

// Lee el catálogo de bardas (generado por scripts/build-bardas.mjs).
export async function cargarBardas() {
  if (catalogo) return catalogo;
  const res = await fetch(import.meta.env.BASE_URL + 'bardas.json');
  if (!res.ok) throw new Error('No se pudo cargar el catálogo de bardas.');
  const datos = await res.json();
  catalogo = datos.bardas || [];
  return catalogo;
}

// ¿Este registro saca la barda de la lista de pendientes?
//
// - Anulado (se tocó la barda equivocada): no, vuelve a pendientes.
// - Cualquier resultado registrado (con permiso, sin permiso, visitado, no
//   habitado) cierra la barda: no se vuelve a repetir sola. "Visitado" se
//   queda así hasta que alguien la reabra y cambie el resultado a mano.
// - Registros viejos, de antes de que existiera `estado`: se guían por la
//   columna `permiso` de siempre.
export function bardaAtendida(p) {
  return Boolean(p && !p.anulado);
}

const visitadas = (permisos) =>
  new Set((permisos || []).filter(bardaAtendida).map((p) => String(p.barda_id)));

// Bardas que todavía se pueden visitar y SÍ se pueden rutear (tienen
// coordenadas). `permisos` viene de la nube (bardas_permisos).
export function bardasPendientes(bardas, permisos) {
  const ya = visitadas(permisos);
  return bardas.filter((b) => b.lat != null && !ya.has(String(b.id)));
}

// QUÉ bardas se hacen hoy ya no lo decide la app: las elige el equipo,
// apartándolas una por una con su nombre (ver apartarBarda en nube.js). Antes
// se escogía sola una "zona compacta" cercana, pero eso ataba el apartado al
// arranque del recorrido: si se cerraba la app, el equipo perdía su selección.
// Aquí solo se ORDENA lo que el equipo ya eligió.

// Ordena un conjunto ya elegido: desde `origen`, siempre la más cercana.
// Determinista (los empates se rompen por id).
export function ordenarPorCercania(origen, bardas) {
  const restantes = bardas.slice();
  const orden = [];
  let desde = origen;
  while (restantes.length > 0) {
    let iMejor = 0, dMejor = Infinity;
    for (let i = 0; i < restantes.length; i++) {
      const d = haversine(desde, [restantes[i].lat, restantes[i].lng]);
      if (d < dMejor - 1e-9 || (Math.abs(d - dMejor) <= 1e-9 && restantes[i].id < restantes[iMejor].id)) {
        dMejor = d;
        iMejor = i;
      }
    }
    const elegida = restantes.splice(iMejor, 1)[0];
    orden.push({ ...elegida, metrosDesdeAnterior: Math.round(dMejor) });
    desde = [elegida.lat, elegida.lng];
  }
  return orden;
}

// Metros totales del recorrido propuesto (sin contar el regreso).
export function largoDeRuta(ruta) {
  return ruta.reduce((s, b) => s + (b.metrosDesdeAnterior || 0), 0);
}

// --- ruta POR CALLES REALES -------------------------------------------------
// La versión de arriba ordena por distancia en línea recta (rápida, pero no
// sabe de calles: dos bardas pueden estar cerca "a vuelo de pájaro" y lejos
// caminando, p. ej. separadas por una barranca o una avenida sin cruce).
// Esta baja las calles de la zona y ordena por lo que de verdad hay que
// caminar, y además devuelve el trazo para dibujarlo sobre el mapa.
//
// Devuelve { ruta, porCalles }. Si no se pudieron bajar las calles (sin señal,
// Overpass caído), regresa la ruta en línea recta con porCalles = false: la
// jornada no se detiene por eso.
// `seleccionadas` son las bardas que el equipo ya apartó: aquí no se descarta
// ninguna, solo se pone en el mejor orden para caminarlas.
export async function rutaDeBardasPorCalles(origen, seleccionadas) {
  // Primero un orden en línea recta (instantáneo): sirve de respaldo si no se
  // pueden bajar las calles, y acota el área que hay que descargar.
  const candidatas = ordenarPorCercania(origen, seleccionadas);
  if (candidatas.length === 0) return { ruta: [], porCalles: false };

  let red = null;
  try {
    const { redParaPuntos } = await import('./ruteo.js');
    red = await redParaPuntos([origen, ...candidatas.map((b) => [b.lat, b.lng])]);
  } catch {
    red = null; // sin calles: se sigue con la ruta en línea recta
  }
  if (!red) return { ruta: candidatas, porCalles: false };

  const { caminosDesde } = await import('./ruteo.js');
  const restantes = candidatas.slice();
  const orden = [];
  let desde = origen;

  while (restantes.length > 0) {
    const caminos = caminosDesde(
      red,
      desde,
      restantes.map((b) => [b.lat, b.lng])
    );
    // La más cercana CAMINANDO; si alguna quedó sin camino (calle aislada),
    // se decide por línea recta para no dejarla fuera de la jornada.
    let iMejor = -1, mejor = null;
    for (let i = 0; i < restantes.length; i++) {
      const c = caminos.get(i);
      if (!c) continue;
      if (mejor === null || c.metros < mejor.metros ||
          (c.metros === mejor.metros && restantes[i].id < restantes[iMejor].id)) {
        mejor = c;
        iMejor = i;
      }
    }
    if (iMejor === -1) {
      // Ninguna alcanzable por calle: se toma la más cercana en línea recta.
      let dMejor = Infinity;
      for (let i = 0; i < restantes.length; i++) {
        const d = haversine(desde, [restantes[i].lat, restantes[i].lng]);
        if (d < dMejor) { dMejor = d; iMejor = i; }
      }
      mejor = { metros: Math.round(dMejor), linea: null };
    }
    const elegida = restantes.splice(iMejor, 1)[0];
    orden.push({
      ...elegida,
      metrosDesdeAnterior: mejor.metros,
      // Trazo por calles desde la barda anterior (null = no se pudo rutear).
      trazo: mejor.linea
    });
    desde = [elegida.lat, elegida.lng];
  }
  return { ruta: orden, porCalles: true };
}

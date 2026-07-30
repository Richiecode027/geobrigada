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

// Un registro anulado (se tocó la barda equivocada) no cuenta como visita: esa
// barda vuelve a la lista de pendientes.
const visitadas = (permisos) =>
  new Set((permisos || []).filter((p) => !p.anulado).map((p) => String(p.barda_id)));

// Bardas que todavía se pueden visitar y SÍ se pueden rutear (tienen
// coordenadas). `permisos` viene de la nube (bardas_permisos).
export function bardasPendientes(bardas, permisos) {
  const ya = visitadas(permisos);
  return bardas.filter((b) => b.lat != null && !ya.has(String(b.id)));
}

// Bardas pendientes SIN coordenadas: el que las capturó no dejó link de mapa
// (o el link apuntaba a un negocio sin coordenadas). No se pueden pintar ni
// meter en la ruta, pero hay que ir a preguntar igual, así que se listan
// aparte con su dirección para que no se pierdan.
export function bardasSinUbicacion(bardas, permisos) {
  const ya = visitadas(permisos);
  return bardas.filter((b) => b.lat == null && !ya.has(String(b.id)));
}

// Elige QUÉ bardas hacer hoy: una ZONA COMPACTA, no las que vayan quedando
// cerca una de otra en cadena.
//
// Por qué: el método de "la siguiente más cercana" se mete en un grupo, lo
// agota y luego tiene que dar un salto enorme al siguiente grupo — en Morelia
// eso significaba cruzar la ciudad a media jornada. Aquí se prueban varias
// zonas de arranque (las bardas más cercanas al equipo) y se elige la que deje
// el recorrido total más corto: así se trabaja una zona y se camina poco entre
// barda y barda. Determinista.
// Cuántas zonas distintas se prueban antes de decidir (más = mejor ruta pero
// más cálculo; con 15 basta y es instantáneo).
const SEMILLAS = 15;

export function zonaDeTrabajo(origen, pendientes, cuantas) {
  if (pendientes.length === 0) return [];
  if (pendientes.length <= cuantas) return pendientes.slice();

  const dist = (a, b) => haversine([a.lat ?? a[0], a.lng ?? a[1]], [b.lat, b.lng]);
  const cercanasAlEquipo = pendientes
    .map((b) => ({ b, d: haversine(origen, [b.lat, b.lng]) }))
    .sort((x, y) => x.d - y.d || (x.b.id < y.b.id ? -1 : 1))
    .slice(0, SEMILLAS)
    .map((x) => x.b);

  let mejor = null;
  for (const semilla of cercanasAlEquipo) {
    // Las `cuantas` bardas más pegadas a esa semilla forman la zona candidata.
    const zona = pendientes
      .map((b) => ({ b, d: dist(semilla, b) }))
      .sort((x, y) => x.d - y.d || (x.b.id < y.b.id ? -1 : 1))
      .slice(0, cuantas)
      .map((x) => x.b);
    const costo = largoDeRuta(ordenarPorCercania(origen, zona));
    if (mejor === null || costo < mejor.costo) mejor = { zona, costo };
  }
  return mejor.zona;
}

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

// Ruta de la jornada en línea recta: elige la zona compacta y la ordena.
// (El trazo por calles reales lo hace rutaDeBardasPorCalles, más abajo.)
export function rutaDeBardas(origen, pendientes, limite = 15) {
  return ordenarPorCercania(origen, zonaDeTrabajo(origen, pendientes, limite));
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
export async function rutaDeBardasPorCalles(origen, pendientes, limite = 15) {
  // Primero se decide la ZONA de hoy en línea recta (rápido) — así el área de
  // calles a descargar es la mínima necesaria y las bardas quedan juntas.
  // Después el ruteo real solo reordena y traza dentro de esa zona.
  const candidatas = rutaDeBardas(origen, pendientes, limite);
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

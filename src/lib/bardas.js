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

// Ordena las bardas para visitarlas caminando/manejando lo menos posible:
// desde `origen` toma la más cercana, desde ahí la siguiente más cercana, y
// así. Es el método del "vecino más cercano": no es el óptimo absoluto, pero
// es inmediato y da rutas sensatas. Determinista: con los mismos datos y el
// mismo origen, siempre sale el mismo orden.
//
// `limite` corta la lista a las primeras N (una jornada no alcanza para 160).
export function rutaDeBardas(origen, pendientes, limite = 15) {
  const restantes = pendientes.slice();
  const orden = [];
  let desde = origen;

  while (restantes.length > 0 && orden.length < limite) {
    let iMejor = 0;
    let dMejor = Infinity;
    for (let i = 0; i < restantes.length; i++) {
      const d = haversine(desde, [restantes[i].lat, restantes[i].lng]);
      // El empate se rompe por id, para que el orden no dependa del azar.
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

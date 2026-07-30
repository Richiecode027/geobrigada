// Ruteo de punto a punto POR CALLES REALES, para la fase de bardas.
//
// Ojo con la diferencia: partition.js resuelve "recorrer TODAS las calles de
// una colonia" (cartero chino). Aquí el problema es otro: ir de un punto a
// otro por el camino más corto, y esos puntos pueden estar en colonias
// distintas. Se reutiliza la misma red de calles de OpenStreetMap, pero con
// un Dijkstra propio (con montículo, para que aguante zonas grandes).
//
// Si no se pueden descargar las calles (sin señal, Overpass caído), el que
// llama debe seguir funcionando con distancias en línea recta: por eso aquí
// nunca se lanza una excepción hacia arriba sin avisar.

import { haversine, ringsBounds } from './geo.js';
import { obtenerCalles } from '../api/overpass.js';
import { buildUnits } from './units.js';

// Precisión con la que dos puntos se consideran la misma esquina (~11 cm).
const clave = (p) => p[0].toFixed(6) + ',' + p[1].toFixed(6);

// Montículo binario mínimo: Dijkstra sobre miles de esquinas sin que el
// teléfono se quede pensando (la versión de partition.js busca el mínimo
// recorriendo todo, que aquí sería demasiado lento).
class ColaMin {
  constructor() {
    this.a = [];
  }
  get tam() {
    return this.a.length;
  }
  push(nodo, prio) {
    this.a.push({ nodo, prio });
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].prio <= this.a[i].prio) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  pop() {
    const top = this.a[0];
    const ult = this.a.pop();
    if (this.a.length > 0) {
      this.a[0] = ult;
      let i = 0;
      for (;;) {
        const izq = 2 * i + 1, der = 2 * i + 2;
        let min = i;
        if (izq < this.a.length && this.a[izq].prio < this.a[min].prio) min = izq;
        if (der < this.a.length && this.a[der].prio < this.a[min].prio) min = der;
        if (min === i) break;
        [this.a[min], this.a[i]] = [this.a[i], this.a[min]];
        i = min;
      }
    }
    return top;
  }
}

// Red de calles lista para rutear: esquinas conectadas por tramos.
export function construirRed(units) {
  const vecinos = new Map(); // clave de esquina -> [{ hasta, metros, coords }]
  const puntos = new Map(); // clave de esquina -> [lat,lng]

  const agregar = (a, b, coords, metros) => {
    const ka = clave(a), kb = clave(b);
    puntos.set(ka, a);
    puntos.set(kb, b);
    if (!vecinos.has(ka)) vecinos.set(ka, []);
    if (!vecinos.has(kb)) vecinos.set(kb, []);
    // Se camina en los dos sentidos (se va a pie, tocando puertas).
    vecinos.get(ka).push({ hasta: kb, metros, coords });
    vecinos.get(kb).push({ hasta: ka, metros, coords: coords.slice().reverse() });
  };

  for (const u of units) {
    agregar(u.coords[0], u.coords[u.coords.length - 1], u.coords, u.length);
  }
  return { vecinos, puntos };
}

// Esquina de la red más cercana a un punto suelto (una barda no cae justo en
// una esquina). Devuelve null si la más cercana está absurdamente lejos.
export function esquinaMasCercana(red, p, maxMetros = 250) {
  let mejor = null, mejorD = Infinity;
  for (const [k, q] of red.puntos) {
    const d = haversine(p, q);
    if (d < mejorD) { mejorD = d; mejor = k; }
  }
  return mejorD <= maxMetros ? mejor : null;
}

// Dijkstra desde una esquina: distancias y de dónde se llegó a cada una.
function dijkstra(red, desde) {
  const dist = new Map([[desde, 0]]);
  const prev = new Map();
  const listo = new Set();
  const cola = new ColaMin();
  cola.push(desde, 0);

  while (cola.tam > 0) {
    const { nodo } = cola.pop();
    if (listo.has(nodo)) continue;
    listo.add(nodo);
    const d = dist.get(nodo);
    for (const ar of red.vecinos.get(nodo) || []) {
      const nd = d + ar.metros;
      if (nd < (dist.has(ar.hasta) ? dist.get(ar.hasta) : Infinity)) {
        dist.set(ar.hasta, nd);
        prev.set(ar.hasta, { desde: nodo, coords: ar.coords });
        cola.push(ar.hasta, nd);
      }
    }
  }
  return { dist, prev };
}

// Camino de esquina a esquina, como lista de coordenadas para dibujar.
function reconstruir(prev, desde, hasta) {
  const partes = [];
  let cur = hasta;
  while (cur !== desde) {
    const p = prev.get(cur);
    if (!p) return null; // no hay camino
    partes.unshift(p.coords);
    cur = p.desde;
  }
  const linea = [];
  for (const parte of partes) {
    for (const punto of parte) {
      const ult = linea[linea.length - 1];
      if (!ult || ult[0] !== punto[0] || ult[1] !== punto[1]) linea.push(punto);
    }
  }
  return linea;
}

// Descarga las calles de la zona que cubren estos puntos y arma la red.
// `margenM` agranda el área para no cortar calles justo en la orilla.
export async function redParaPuntos(puntos, margenM = 400) {
  if (!puntos || puntos.length === 0) return null;
  const [[minLat, minLng], [maxLat, maxLng]] = ringsBounds([puntos]);
  const dLat = margenM / 111320;
  const dLng = margenM / (111320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180));
  // Se pide como un rectángulo (obtenerCalles ya consulta por caja envolvente).
  const caja = [
    [minLat - dLat, minLng - dLng],
    [minLat - dLat, maxLng + dLng],
    [maxLat + dLat, maxLng + dLng],
    [maxLat + dLat, minLng - dLng],
    [minLat - dLat, minLng - dLng]
  ];
  const ways = await obtenerCalles([caja]);
  const units = buildUnits(ways, [caja]);
  if (units.length === 0) return null;
  return construirRed(units);
}

// Distancias reales por calle desde un punto a todos los demás, y el camino
// dibujable hacia cada uno. Devuelve un mapa indice -> { metros, linea }.
export function caminosDesde(red, origen, destinos) {
  const kOrigen = esquinaMasCercana(red, origen);
  const salida = new Map();
  if (!kOrigen) return salida;
  const { dist, prev } = dijkstra(red, kOrigen);

  destinos.forEach((d, i) => {
    const kDestino = esquinaMasCercana(red, d);
    if (!kDestino || !dist.has(kDestino)) return;
    const linea = kOrigen === kDestino ? [] : reconstruir(prev, kOrigen, kDestino);
    if (linea === null) return;
    salida.set(i, {
      // Se suman los tramitos del punto real a su esquina, para no mentir
      // en la distancia mostrada.
      metros: Math.round(
        dist.get(kDestino) +
          haversine(origen, red.puntos.get(kOrigen)) +
          haversine(d, red.puntos.get(kDestino))
      ),
      // El dibujo empieza y termina en el punto real, no en la esquina.
      linea: [origen, ...linea, d]
    });
  });
  return salida;
}

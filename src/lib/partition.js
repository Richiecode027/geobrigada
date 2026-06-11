// Reparte las unidades (tramos de calle) entre N equipos y ordena el recorrido.
//
// IMPORTANTE: todo aquí es DETERMINISTA (sin Math.random). Con los mismos
// datos de entrada el resultado es idéntico, lo que permite que el teléfono
// de cada brigadista recalcule las rutas y vea exactamente la misma división
// que generó el coordinador, sin necesidad de un servidor.

import { haversine } from './geo.js';

// Grafo de conectividad: dos tramos son vecinos si comparten un nodo de la
// red de calles de OSM (una esquina, o la continuación de la misma calle).
function claveCoord(p) {
  return p[0].toFixed(6) + ',' + p[1].toFixed(6);
}

export function buildAdjacency(units) {
  const porNodo = new Map();
  units.forEach((u, i) => {
    for (const p of u.coords) {
      const c = claveCoord(p);
      let lista = porNodo.get(c);
      if (!lista) {
        lista = [];
        porNodo.set(c, lista);
      }
      if (lista[lista.length - 1] !== i) lista.push(i);
    }
  });
  const ady = units.map(() => new Set());
  for (const lista of porNodo.values()) {
    if (lista.length < 2) continue;
    for (let a = 0; a < lista.length; a++) {
      for (let b = a + 1; b < lista.length; b++) {
        ady[lista[a]].add(lista[b]);
        ady[lista[b]].add(lista[a]);
      }
    }
  }
  return ady;
}

// Reparto por CRECIMIENTO CONECTADO (determinista): las zonas crecen desde
// semillas alejadas entre sí, como manchas de tinta sobre la red de calles.
// En cada paso, el equipo con menos kilómetros acumulados toma el tramo
// frontera más compacto respecto a su zona. Así cada zona queda en un solo
// bloque continuo y balanceada, sin islas dentro del territorio de otra.
export function partition(units, k) {
  if (units.length === 0) return [];
  k = Math.min(k, units.length);
  if (k <= 1) return [units.slice()];

  const ady = buildAdjacency(units);
  const pts = units.map((u) => u.mid);

  // Semillas deterministas: la más al oeste y luego puntos lo más lejanos posible.
  let start = 0;
  for (let i = 1; i < pts.length; i++) {
    if (
      pts[i][1] < pts[start][1] ||
      (pts[i][1] === pts[start][1] && pts[i][0] < pts[start][0])
    ) {
      start = i;
    }
  }
  const semillas = [start];
  while (semillas.length < k) {
    let best = -1, bestD = -1;
    for (let i = 0; i < pts.length; i++) {
      if (semillas.includes(i)) continue;
      let d = Infinity;
      for (const s of semillas) d = Math.min(d, haversine(pts[i], pts[s]));
      if (d > bestD) { bestD = d; best = i; }
    }
    semillas.push(best);
  }

  const assign = new Array(units.length).fill(-1);
  const loads = new Array(k).fill(0);
  // Centroide ponderado de cada zona, para elegir el tramo frontera más compacto.
  const cLat = new Array(k).fill(0);
  const cLng = new Array(k).fill(0);
  const cW = new Array(k).fill(0);
  const frontera = Array.from({ length: k }, () => new Set());

  function asignar(i, r) {
    assign[i] = r;
    loads[r] += units[i].length;
    cLat[r] += pts[i][0] * units[i].length;
    cLng[r] += pts[i][1] * units[i].length;
    cW[r] += units[i].length;
    for (let q = 0; q < k; q++) frontera[q].delete(i);
    for (const v of ady[i]) {
      if (assign[v] === -1) frontera[r].add(v);
    }
  }

  semillas.forEach((s, r) => asignar(s, r));

  // ¿La zona quedó en una isla sin NINGUNA conexión con el resto de la red?
  // (p. ej. su semilla cayó en un andador suelto). Distinto de estar
  // encajonada entre otras zonas, que se arregla después con el rebalanceo.
  function zonaAislada(r) {
    for (let i = 0; i < units.length; i++) {
      if (assign[i] !== r) continue;
      for (const v of ady[i]) {
        if (assign[v] !== r) return false;
      }
    }
    return true;
  }

  function resembrar(r) {
    const centro = [cLat[r] / cW[r], cLng[r] / cW[r]];
    let best = -1, bestD = Infinity;
    for (let i = 0; i < units.length; i++) {
      if (assign[i] !== -1) continue;
      const d = haversine(pts[i], centro);
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && i < best)) {
        bestD = d;
        best = i;
      }
    }
    if (best !== -1) asignar(best, r);
    return best !== -1;
  }

  let restantes = units.length - k;
  while (restantes > 0) {
    // Turnos por carga: el equipo con menos kilómetros intenta crecer primero.
    const orden = [...Array(k).keys()].sort((a, b) => loads[a] - loads[b] || a - b);
    let progreso = false;
    for (const r of orden) {
      if (frontera[r].size > 0) {
        const centro = [cLat[r] / cW[r], cLng[r] / cW[r]];
        let best = -1, bestD = Infinity;
        for (const i of frontera[r]) {
          const d = haversine(pts[i], centro);
          if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && i < best)) {
            bestD = d;
            best = i;
          }
        }
        asignar(best, r);
        restantes--;
        progreso = true;
        break;
      }
      // Sin frontera: si es una isla aislada de la red, se re-siembra donde
      // sí hay calles pendientes; si solo está encajonada, le toca a la que sigue.
      if (zonaAislada(r) && resembrar(r)) {
        restantes--;
        progreso = true;
        break;
      }
    }
    if (!progreso) break; // solo quedan componentes sueltas, se asignan abajo
  }

  // Componentes de calles aisladas (sin conexión con el resto de la red):
  // cada componente completa se va con la zona cuyo centro quede más cerca.
  if (restantes > 0) {
    for (let i = 0; i < units.length; i++) {
      if (assign[i] !== -1) continue;
      // junta toda la componente conectada de i
      const comp = [i];
      const visto = new Set(comp);
      for (let p = 0; p < comp.length; p++) {
        for (const v of ady[comp[p]]) {
          if (assign[v] === -1 && !visto.has(v)) {
            visto.add(v);
            comp.push(v);
          }
        }
      }
      let mLat = 0, mLng = 0, mW = 0;
      for (const j of comp) {
        mLat += pts[j][0] * units[j].length;
        mLng += pts[j][1] * units[j].length;
        mW += units[j].length;
      }
      const mc = [mLat / mW, mLng / mW];
      let r = 0, bestD = Infinity;
      for (let q = 0; q < k; q++) {
        const d = cW[q] > 0 ? haversine(mc, [cLat[q] / cW[q], cLng[q] / cW[q]]) : Infinity;
        if (d < bestD) { bestD = d; r = q; }
      }
      for (const j of comp) asignar(j, r);
    }
  }

  // --- utilerías compartidas por el rebalanceo y el suavizado ---------------

  const centroide = (r) => [cLat[r] / cW[r], cLng[r] / cW[r]];

  // Número de piezas (componentes) de la zona `r`, opcionalmente sin un tramo.
  // La red real de una colonia puede traer privadas/andadores aislados, así
  // que la regla es: ningún movimiento debe AUMENTAR las piezas de la zona.
  const contarPiezas = (r, excluido) => {
    const visto = new Set();
    let piezas = 0;
    for (let i = 0; i < units.length; i++) {
      if (assign[i] !== r || i === excluido || visto.has(i)) continue;
      piezas++;
      visto.add(i);
      const cola = [i];
      while (cola.length) {
        for (const v of ady[cola.pop()]) {
          if (assign[v] === r && v !== excluido && !visto.has(v)) {
            visto.add(v);
            cola.push(v);
          }
        }
      }
    }
    return piezas;
  };

  const moverTramo = (i, de, a) => {
    assign[i] = a;
    loads[de] -= units[i].length;
    loads[a] += units[i].length;
    cLat[de] -= pts[i][0] * units[i].length;
    cLng[de] -= pts[i][1] * units[i].length;
    cW[de] -= units[i].length;
    cLat[a] += pts[i][0] * units[i].length;
    cLng[a] += pts[i][1] * units[i].length;
    cW[a] += units[i].length;
  };

  // --- rebalanceo: empareja kilómetros entre la zona más cargada y la más
  // ligera. Los tramos se ceden hacia el CENTRO de la zona ligera (no hacia su
  // calle más cercana) para que el traspaso crezca compacto y no en hilera.
  const total = loads.reduce((a, b) => a + b, 0);
  const objetivo = total / k;
  // Intenta ceder UN tramo de la zona `over` a la zona `under` respetando
  // contigüidad. Devuelve true si pudo.
  const cederTramo = (over, under) => {
    const cUnder = centroide(under);
    const underIdx = [];
    for (let i = 0; i < units.length; i++) if (assign[i] === under) underIdx.push(i);
    const info = new Map();
    const candidatos = [];
    for (let i = 0; i < units.length; i++) {
      if (assign[i] !== over) continue;
      let tocaUnder = false;
      for (const v of ady[i]) {
        if (assign[v] === under) { tocaUnder = true; break; }
      }
      if (!tocaUnder) {
        // Sin conexión en la red: solo se cede si está pegado físicamente a
        // la zona receptora (colonias partidas por una avenida), nunca lejos.
        let dMin = Infinity;
        for (const j of underIdx) {
          dMin = Math.min(dMin, haversine(pts[i], pts[j]));
          if (dMin <= 250) break;
        }
        if (dMin > 250) continue;
      }
      info.set(i, [tocaUnder ? 0 : 1, haversine(pts[i], cUnder)]);
      candidatos.push(i);
    }
    candidatos.sort((a, b) => {
      const ia = info.get(a), ib = info.get(b);
      return ia[0] - ib[0] || ia[1] - ib[1] || a - b;
    });

    const piezasAhora = contarPiezas(over, -1);
    for (const i of candidatos) {
      if (contarPiezas(over, i) <= piezasAhora) {
        moverTramo(i, over, under);
        return true;
      }
    }
    return false;
  };

  // Rebalanceo en cascada: la zona más cargada cede a cualquier zona menos
  // cargada que la reciba (el exceso fluye de vecina en vecina hasta la más
  // ligera, aunque estén en extremos opuestos de la colonia).
  const rebalancear = () => {
    for (let pase = 0; pase < 400; pase++) {
      let over = 0, under = 0;
      for (let q = 1; q < k; q++) {
        if (loads[q] > loads[over]) over = q;
        if (loads[q] < loads[under]) under = q;
      }
      if (loads[over] <= objetivo * 1.08 && loads[under] >= objetivo * 0.92) break;

      const receptoras = [...Array(k).keys()]
        .filter((q) => q !== over && loads[q] < loads[over] - 150)
        .sort((a, b) => loads[a] - loads[b] || a - b);
      let movio = false;
      for (const q of receptoras) {
        if (cederTramo(over, q)) { movio = true; break; }
      }
      if (!movio) break;
    }
  };
  rebalancear();

  // --- suavizado anti-tentáculos: un tramo pegado a otra zona y claramente
  // más cerca del corazón de esa zona que del de la suya se cambia de equipo,
  // siempre que no parta su zona ni desbalancee los kilómetros.
  for (let pase = 0; pase < 30; pase++) {
    let cambio = false;
    for (let i = 0; i < units.length; i++) {
      const r = assign[i];
      const dPropio = haversine(pts[i], centroide(r));
      let mejorS = -1, mejorD = Infinity;
      for (const v of ady[i]) {
        const s = assign[v];
        if (s === r) continue;
        const d = haversine(pts[i], centroide(s));
        if (d < mejorD) { mejorD = d; mejorS = s; }
      }
      if (mejorS === -1 || mejorD > dPropio * 0.7) continue;
      if (loads[r] - units[i].length < objetivo * 0.85) continue;
      if (loads[mejorS] + units[i].length > objetivo * 1.15) continue;
      if (contarPiezas(r, i) > contarPiezas(r, -1)) continue;
      moverTramo(i, r, mejorS);
      cambio = true;
    }
    if (!cambio) break;
  }

  // El suavizado puede desajustar un poco los kilómetros: se empareja de nuevo.
  rebalancear();

  const groups = Array.from({ length: k }, () => []);
  for (let i = 0; i < units.length; i++) groups[assign[i]].push(units[i]);
  return groups.filter((g) => g.length > 0);
}

// Punto de encuentro de todas las brigadas: el centro de gravedad de las
// calles (ponderado por longitud), ajustado al punto de calle más cercano
// para que sea un lugar real donde pararse. Determinista.
export function puntoDeEncuentro(units) {
  if (units.length === 0) return null;
  let sLat = 0, sLng = 0, sW = 0;
  for (const u of units) {
    sLat += u.mid[0] * u.length;
    sLng += u.mid[1] * u.length;
    sW += u.length;
  }
  const centro = [sLat / sW, sLng / sW];
  let mejor = null, mejorD = Infinity;
  for (const u of units) {
    for (const p of u.coords) {
      const d = haversine(centro, p);
      if (d < mejorD) { mejorD = d; mejor = p; }
    }
  }
  return mejor;
}

// Ordena los tramos de un equipo en un recorrido continuo y caminable.
// Prefiere SIEMPRE continuar por un tramo conectado al actual (misma calle o
// esquina); solo cuando se acaba un callejón sin salida "salta" al tramo
// pendiente más cercano dentro de su propia zona. Determinista.
// Si se da `inicio` (el punto de encuentro), la ruta arranca desde ahí.
export function orderRoute(units, inicio = null) {
  if (units.length === 0) return [];
  const ady = buildAdjacency(units);
  const remaining = new Set(units.map((_, i) => i));
  const route = [];

  let curEnd = inicio;
  let cur = -1;
  if (curEnd === null) {
    // Arranque determinista sin punto de encuentro: el tramo más al suroeste.
    for (const i of remaining) {
      if (
        cur === -1 ||
        units[i].mid[0] + units[i].mid[1] < units[cur].mid[0] + units[cur].mid[1]
      ) {
        cur = i;
      }
    }
    remaining.delete(cur);
    route.push({ ...units[cur] });
    curEnd = units[cur].coords[units[cur].coords.length - 1];
  }

  while (remaining.size > 0) {
    // Candidatos: primero los tramos conectados al actual; si no hay
    // (callejón sin salida o arranque), todos los pendientes de la zona.
    let candidatos = null;
    let conectados = false;
    if (cur !== -1) {
      candidatos = [];
      for (const v of ady[cur]) {
        if (remaining.has(v)) candidatos.push(v);
      }
      conectados = candidatos.length > 0;
    }
    if (!candidatos || candidatos.length === 0) candidatos = [...remaining];

    // Regla de Warnsdorff: entre los tramos conectados, primero el que tenga
    // menos continuaciones pendientes (callejones y puntas), para no dejarlos
    // atrás y tener que regresar. Empata por cercanía y luego por id.
    let next = -1, flip = false, bestD = Infinity, bestGrado = Infinity;
    for (const i of candidatos) {
      // Warnsdorff solo entre tramos conectados; en saltos manda la cercanía.
      let grado = 0;
      if (conectados) {
        for (const v of ady[i]) if (remaining.has(v)) grado++;
      }
      const a = units[i].coords[0];
      const b = units[i].coords[units[i].coords.length - 1];
      const dA = haversine(curEnd, a);
      const dB = haversine(curEnd, b);
      const [dMin, flipMin] = dA <= dB ? [dA, false] : [dB, true];
      if (
        grado < bestGrado ||
        (grado === bestGrado &&
          (dMin < bestD - 1e-9 || (Math.abs(dMin - bestD) <= 1e-9 && i < next)))
      ) {
        bestGrado = grado;
        bestD = dMin;
        next = i;
        flip = flipMin;
      }
    }
    remaining.delete(next);
    const u = units[next];
    const coords = flip ? u.coords.slice().reverse() : u.coords;
    route.push({ ...u, coords });
    curEnd = coords[coords.length - 1];
    cur = next;
  }
  return route;
}

export const TEAM_COLORS = [
  '#e63946', '#1d6fd1', '#2a9d3a', '#ff8c00',
  '#8338ec', '#00a8a8', '#d81b9c', '#7a5230'
];

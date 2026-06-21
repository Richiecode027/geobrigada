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

// --- grafo de calles compartido (conectores y saltos por la red) -----------
// Nodo = esquina (clave de coordenada); arista = tramo, caminable en ambos
// sentidos (también de regreso por una calle ya repartida).
function grafoDeUnidades(units) {
  const aristasPorNodo = new Map();
  units.forEach((u, idx) => {
    const a = claveCoord(u.coords[0]);
    const b = claveCoord(u.coords[u.coords.length - 1]);
    const arista = { a, b, coords: u.coords, len: u.length, name: u.name, unit: idx };
    if (!aristasPorNodo.has(a)) aristasPorNodo.set(a, []);
    if (!aristasPorNodo.has(b)) aristasPorNodo.set(b, []);
    aristasPorNodo.get(a).push(arista);
    aristasPorNodo.get(b).push(arista);
  });
  return aristasPorNodo;
}

// Distancias caminando por la red desde un nodo a todos los demás (Dijkstra).
// Si `conPrev` es true, también devuelve de dónde se llegó a cada nodo, para
// reconstruir el camino. Determinista.
function dijkstraDesde(grafo, desde, conPrev = false) {
  const dist = new Map([[desde, 0]]);
  const prev = conPrev ? new Map() : null;
  const visto = new Set();
  while (true) {
    let u = null, best = Infinity;
    for (const [n, d] of dist) {
      if (!visto.has(n) && d < best) { best = d; u = n; }
    }
    if (u === null) break;
    visto.add(u);
    for (const ar of grafo.get(u) || []) {
      const v = ar.a === u ? ar.b : ar.a;
      const nd = best + ar.len;
      if (nd < (dist.has(v) ? dist.get(v) : Infinity)) {
        dist.set(v, nd);
        if (prev) prev.set(v, { from: u, ar });
      }
    }
  }
  return { dist, prev };
}

// MÉTODO CODICIOSO (red de seguridad de orderRoute). Recorre encadenando por
// esquinas; en callejón sin salida salta al tramo con el regreso más corto por
// la red. Siempre cubre todos los tramos. Determinista. Si se da `inicio`, la
// ruta arranca desde ahí.
function ordenCodicioso(units, inicio = null) {
  if (units.length === 0) return [];
  const ady = buildAdjacency(units);
  const grafo = grafoDeUnidades(units);
  const remaining = new Set(units.map((_, i) => i));
  const route = [];

  // Tramo pendiente más cercano a `curEnd` en línea recta (orienta el tramo).
  const masCercanoRecto = () => {
    let next = -1, flip = false, bestD = Infinity;
    for (const i of remaining) {
      const a = units[i].coords[0];
      const b = units[i].coords[units[i].coords.length - 1];
      const dA = haversine(curEnd, a);
      const dB = haversine(curEnd, b);
      const [dMin, flipMin] = dA <= dB ? [dA, false] : [dB, true];
      if (dMin < bestD - 1e-9 || (Math.abs(dMin - bestD) <= 1e-9 && i < next)) {
        bestD = dMin; next = i; flip = flipMin;
      }
    }
    return [next, flip];
  };

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
    // Candidatos conectados al tramo actual (misma calle o esquina).
    const candidatos = [];
    if (cur !== -1) {
      for (const v of ady[cur]) if (remaining.has(v)) candidatos.push(v);
    }

    let next = -1, flip = false;

    if (candidatos.length > 0) {
      // Regla de Warnsdorff: primero el conectado con menos continuaciones
      // pendientes (callejones y puntas), para no dejarlos atrás y regresar.
      // Empata por cercanía y luego por id.
      let bestD = Infinity, bestGrado = Infinity;
      for (const i of candidatos) {
        let grado = 0;
        for (const v of ady[i]) if (remaining.has(v)) grado++;
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
          bestGrado = grado; bestD = dMin; next = i; flip = flipMin;
        }
      }
    } else if (cur !== -1) {
      // Callejón sin salida: salta al tramo con el regreso más corto por la red.
      const { dist } = dijkstraDesde(grafo, claveCoord(curEnd));
      let bestNet = Infinity;
      for (const i of remaining) {
        const a = claveCoord(units[i].coords[0]);
        const b = claveCoord(units[i].coords[units[i].coords.length - 1]);
        const da = dist.has(a) ? dist.get(a) : Infinity;
        const db = dist.has(b) ? dist.get(b) : Infinity;
        const [dMin, flipMin] = da <= db ? [da, false] : [db, true];
        if (dMin < bestNet - 1e-9 || (Math.abs(dMin - bestNet) <= 1e-9 && i < next)) {
          bestNet = dMin; next = i; flip = flipMin;
        }
      }
      // Tramo en otra componente (sin calle que lo una): cae a línea recta.
      if (next === -1 || bestNet === Infinity) [next, flip] = masCercanoRecto();
    } else {
      // Arranque con punto de encuentro: el tramo más cercano a él.
      [next, flip] = masCercanoRecto();
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

// RUTA DEL CARTERO CHINO (versión simple). Recorre TODAS las calles caminando
// lo menos posible de más. La idea (ver dibujo en la app): en las esquinas con
// un número PAR de calles entras y sales sin repetir; las IMPARES (callejones,
// cruces en T) obligan a repetir. El truco: emparejar las esquinas impares por
// cercanía y "duplicar" esas pocas calles; así todas quedan pares y existe un
// recorrido (circuito de Euler) que pasa por todo con el mínimo de repeticiones.
// Todo determinista (sin azar): cada teléfono calcula la misma ruta.
function rutaCartero(units, inicio) {
  const n = units.length;
  const grafo = grafoDeUnidades(units); // nodo -> [aristas {a,b,len,coords,unit}]

  // Punto de referencia para arrancar (y ordenar piezas sueltas): el de
  // encuentro o, si no hay, la esquina más al suroeste.
  let ref = inicio;
  if (!ref) {
    for (const u of units) {
      const e = u.coords[0];
      if (!ref || e[0] + e[1] < ref[0] + ref[1]) ref = e;
    }
  }

  // 1) Componentes conexas (sobre las esquinas, vía las calles requeridas).
  const compDe = new Map(); // nodo -> id de componente
  const comps = []; // [{ nodos:Set, unidades:Set }]
  for (const nodo of grafo.keys()) {
    if (compDe.has(nodo)) continue;
    const id = comps.length;
    const comp = { nodos: new Set(), unidades: new Set() };
    comps.push(comp);
    const cola = [nodo];
    compDe.set(nodo, id);
    while (cola.length) {
      const x = cola.pop();
      comp.nodos.add(x);
      for (const ar of grafo.get(x) || []) {
        comp.unidades.add(ar.unit);
        const y = ar.a === x ? ar.b : ar.a;
        if (!compDe.has(y)) { compDe.set(y, id); cola.push(y); }
      }
    }
  }

  // Ordena las componentes: primero la más cercana al punto de referencia.
  const distRefComp = (comp) => {
    let d = Infinity;
    for (const nodo of comp.nodos) {
      const ar = grafo.get(nodo)[0];
      const p = ar.a === nodo ? ar.coords[0] : ar.coords[ar.coords.length - 1];
      d = Math.min(d, haversine(ref, p));
    }
    return d;
  };
  comps.sort((a, b) => distRefComp(a) - distRefComp(b));

  const orden = [];

  for (const comp of comps) {
    // 2) Grado de cada esquina (número de calles que llegan). Impar = se atora.
    const grado = new Map();
    for (const nodo of comp.nodos) grado.set(nodo, (grafo.get(nodo) || []).length);
    const impares = [...comp.nodos].filter((x) => grado.get(x) % 2 === 1);
    impares.sort(); // orden estable (determinista)

    // 3) Empareja las impares por cercanía y "duplica" las calles del camino
    //    más corto entre cada pareja (esas son las que se repiten).
    const multiplicidad = new Map(); // unit -> nº de veces (1 = sin repetir)
    for (const u of comp.unidades) multiplicidad.set(u, 1);
    const pendientes = new Set(impares);
    while (pendientes.size >= 2) {
      const a = [...pendientes].sort()[0];
      pendientes.delete(a);
      const { dist, prev } = dijkstraDesde(grafo, a, true);
      // impar más cercana por la red
      let mejor = null, mejorD = Infinity;
      for (const b of pendientes) {
        const d = dist.has(b) ? dist.get(b) : Infinity;
        if (d < mejorD - 1e-9 || (Math.abs(d - mejorD) <= 1e-9 && (mejor === null || b < mejor))) {
          mejorD = d; mejor = b;
        }
      }
      if (mejor === null || mejorD === Infinity) continue; // sin pareja alcanzable
      pendientes.delete(mejor);
      // duplica las calles del camino a -> mejor
      let cur = mejor;
      while (cur !== a) {
        const p = prev.get(cur);
        if (!p) break;
        multiplicidad.set(p.ar.unit, (multiplicidad.get(p.ar.unit) || 1) + 1);
        cur = p.from;
      }
    }

    // 4) Multigrafo con las repeticiones y circuito de Euler (Hierholzer).
    //    Cada "instancia" de calle es un paso caminable; las copias extra son
    //    las repeticiones (regreso).
    const aristas = []; // { a, b, unit, usada, desde }
    const incid = new Map(); // nodo -> [idArista]
    const agregar = (a, b, unit) => {
      const id = aristas.length;
      aristas.push({ a, b, unit, usada: false, desde: null });
      if (!incid.has(a)) incid.set(a, []);
      if (!incid.has(b)) incid.set(b, []);
      incid.get(a).push(id);
      incid.get(b).push(id);
    };
    for (const unit of comp.unidades) {
      const u = units[unit];
      const a = claveCoord(u.coords[0]);
      const b = claveCoord(u.coords[u.coords.length - 1]);
      for (let m = 0; m < multiplicidad.get(unit); m++) agregar(a, b, unit);
    }
    // Orden estable de las aristas en cada esquina (determinismo de Hierholzer).
    for (const lista of incid.values()) {
      lista.sort((i, j) => aristas[i].unit - aristas[j].unit || i - j);
    }

    // Esquina de arranque: la de la componente más cercana al punto de referencia.
    let arranque = null, arrD = Infinity;
    for (const nodo of comp.nodos) {
      const ar = grafo.get(nodo)[0];
      const p = ar.a === nodo ? ar.coords[0] : ar.coords[ar.coords.length - 1];
      const d = haversine(ref, p);
      if (d < arrD - 1e-9 || (Math.abs(d - arrD) <= 1e-9 && (arranque === null || nodo < arranque))) {
        arrD = d; arranque = nodo;
      }
    }

    const ptr = new Map();
    const siguienteArista = (nodo) => {
      const lista = incid.get(nodo) || [];
      let p = ptr.get(nodo) || 0;
      while (p < lista.length && aristas[lista[p]].usada) p++;
      ptr.set(nodo, p);
      return p < lista.length ? lista[p] : -1;
    };

    const pilaNodo = [arranque];
    const pilaArista = [-1];
    const circuito = []; // ids de arista en orden inverso
    while (pilaNodo.length) {
      const v = pilaNodo[pilaNodo.length - 1];
      const e = siguienteArista(v);
      if (e !== -1) {
        aristas[e].usada = true;
        aristas[e].desde = v;
        const w = aristas[e].a === v ? aristas[e].b : aristas[e].a;
        pilaNodo.push(w);
        pilaArista.push(e);
      } else {
        pilaNodo.pop();
        const e2 = pilaArista.pop();
        if (e2 !== -1) circuito.push(e2);
      }
    }
    circuito.reverse();

    // 5) Recorre el circuito; la PRIMERA vez que pasa por una calle es "cubrir"
    //    (queda en el orden, orientada en el sentido de la marcha); las
    //    siguientes son regreso y las dibuja luego recorridoContinuo.
    const cubierta = new Set();
    for (const id of circuito) {
      const ar = aristas[id];
      if (cubierta.has(ar.unit)) continue;
      cubierta.add(ar.unit);
      const u = units[ar.unit];
      const coords =
        claveCoord(u.coords[0]) === ar.desde ? u.coords : u.coords.slice().reverse();
      orden.push({ ...u, coords });
    }
  }

  return orden;
}

// Ordena los tramos de un equipo en un recorrido caminable y eficiente.
// Usa la ruta del cartero chino (mínimo de repeticiones); si por un caso
// degenerado no cubriera todo, cae al método codicioso. Determinista.
// Si se da `inicio` (el punto de encuentro), la ruta arranca desde ahí.
export function orderRoute(units, inicio = null) {
  if (units.length === 0) return [];
  let orden;
  try {
    orden = rutaCartero(units, inicio);
  } catch {
    orden = null;
  }
  // Red de seguridad: el cartero debe cubrir TODOS los tramos exactamente una
  // vez; si no, usa el método codicioso (que siempre cubre todo).
  if (!orden || orden.length !== units.length) return ordenCodicioso(units, inicio);
  return orden;
}

// Arma el RECORRIDO CONTINUO que ve el brigadista: toma los tramos ya ordenados
// por orderRoute y, cuando dos tramos seguidos no se tocan (hay que regresar
// caminando para seguir), inserta el "conector" — el camino más corto por las
// calles de la zona entre el fin de uno y el inicio del siguiente. Así el mapa
// muestra UNA sola línea que se sigue sin pensar: continua = reparte aquí,
// punteada = solo camina para reposicionarte. Determinista.
//
// Devuelve [{ tipo: 'cubrir' | 'conector', coords: [[lat,lng]...], name }].
export function recorridoContinuo(ordenada) {
  if (!ordenada || ordenada.length === 0) return [];

  const grafo = grafoDeUnidades(ordenada);

  // Tramos del camino más corto del nodo `desde` al `hasta` (orientados en el
  // sentido de la marcha), o null si no hay conexión por calle.
  function caminoMasCorto(desde, hasta) {
    if (desde === hasta) return [];
    const { prev } = dijkstraDesde(grafo, desde, true);
    if (!prev.has(hasta)) return null; // inalcanzable (componente suelta)
    const pasos = [];
    let cur = hasta;
    while (cur !== desde) {
      const p = prev.get(cur);
      if (!p) return null;
      const coords =
        claveCoord(p.ar.coords[0]) === p.from
          ? p.ar.coords
          : p.ar.coords.slice().reverse();
      pasos.unshift({ coords, name: p.ar.name });
      cur = p.from;
    }
    return pasos;
  }

  const recorrido = [];
  ordenada.forEach((u, i) => {
    if (i > 0) {
      const prev = ordenada[i - 1];
      const finPrev = prev.coords[prev.coords.length - 1];
      const iniAct = u.coords[0];
      const kFin = claveCoord(finPrev);
      const kIni = claveCoord(iniAct);
      if (kFin !== kIni) {
        const camino = caminoMasCorto(kFin, kIni);
        if (camino && camino.length) {
          for (const c of camino) {
            recorrido.push({ tipo: 'conector', coords: c.coords, name: c.name });
          }
        } else {
          // Sin calle que los una (p. ej. partidos por una plaza): línea recta.
          recorrido.push({ tipo: 'conector', coords: [finPrev, iniAct], name: '' });
        }
      }
    }
    recorrido.push({ tipo: 'cubrir', coords: u.coords, name: u.name });
  });
  return recorrido;
}

// Camino más corto por las calles del equipo desde el punto `desde` (tu GPS)
// hasta la cuadra `uiDestino` (la siguiente a repartir). Sirve para mostrarle
// al brigadista "ve por aquí" cuando la calle que sigue no está pegada a él.
// Devuelve los tramos a caminar para llegar (cada uno [[lat,lng]...]),
// orientados en el sentido de la marcha. Determinista.
export function caminoACalle(ruta, desde, uiDestino) {
  if (!ruta || ruta.length === 0 || uiDestino < 0 || uiDestino >= ruta.length) return [];
  const grafo = grafoDeUnidades(ruta);

  // Esquina más cercana a tu posición (arranque del camino).
  let inicio = null, dIni = Infinity;
  for (const u of ruta) {
    const a = u.coords[0], b = u.coords[u.coords.length - 1];
    const da = haversine(desde, a);
    if (da < dIni) { dIni = da; inicio = claveCoord(a); }
    const db = haversine(desde, b);
    if (db < dIni) { dIni = db; inicio = claveCoord(b); }
  }
  if (inicio == null) return [];

  const dest = ruta[uiDestino];
  const t1 = claveCoord(dest.coords[0]);
  const t2 = claveCoord(dest.coords[dest.coords.length - 1]);
  const { dist, prev } = dijkstraDesde(grafo, inicio, true);
  const d1 = inicio === t1 ? 0 : dist.has(t1) ? dist.get(t1) : Infinity;
  const d2 = inicio === t2 ? 0 : dist.has(t2) ? dist.get(t2) : Infinity;
  if (!isFinite(Math.min(d1, d2))) return []; // calle destino inalcanzable por la red
  const meta = d1 <= d2 ? t1 : t2;

  const pasos = [];
  let cur = meta;
  while (cur !== inicio) {
    const p = prev.get(cur);
    if (!p) break;
    const coords =
      claveCoord(p.ar.coords[0]) === p.from ? p.ar.coords : p.ar.coords.slice().reverse();
    pasos.unshift(coords);
    cur = p.from;
  }
  return pasos;
}

export const TEAM_COLORS = [
  '#e63946', '#1d6fd1', '#2a9d3a', '#ff8c00',
  '#8338ec', '#00a8a8', '#d81b9c', '#7a5230'
];

// Reparto de colonias entre brigadas dentro de una actividad.
//
// Cada brigada tiene una capacidad según su jornada: tiempo completo rinde el
// doble que medio tiempo. La carga de una colonia es su número de viviendas
// (dato del INEGI); si una colonia no tiene ese dato, se usa un valor base
// para que igual se reparta.
//
// El reparto es DETERMINISTA (greedy "el más grande al menos cargado"): la app
// PROPONE este reparto y el coordinador luego mueve colonias a mano si quiere.

const VIV_BASE_SIN_DATO = 150; // viviendas asumidas si la colonia no trae dato

export function capacidadDe(tipo) {
  return tipo === 'medio' ? 0.5 : 1; // completo = 1, medio = 0.5
}

export function vivColonia(c) {
  return c.v && c.v > 0 ? c.v : VIV_BASE_SIN_DATO;
}

// brigadas: [{ id, nombre, tipo }]  ·  pool: [{ k, n, v }]
// Devuelve { [claveColonia]: idBrigada }.
export function repartir(brigadas, pool) {
  const asignacion = {};
  if (brigadas.length === 0) return asignacion;

  // Carga normalizada (viviendas / capacidad) que lleva cada brigada.
  const carga = {};
  for (const b of brigadas) carga[b.id] = 0;

  // Las colonias más grandes primero; empate por clave para que sea estable.
  const orden = [...pool].sort((a, b) => vivColonia(b) - vivColonia(a) || (a.k < b.k ? -1 : 1));

  for (const col of orden) {
    const v = vivColonia(col);
    // Elige la brigada donde quede más pareja la carga por capacidad.
    let mejor = brigadas[0];
    let mejorCarga = Infinity;
    for (const b of brigadas) {
      const cap = capacidadDe(b.tipo);
      const cargaSi = (carga[b.id] + v) / cap;
      if (cargaSi < mejorCarga) {
        mejorCarga = cargaSi;
        mejor = b;
      }
    }
    asignacion[col.k] = mejor.id;
    carga[mejor.id] += v;
  }
  return asignacion;
}

// Totales por brigada a partir de una asignación.
export function resumenBrigadas(brigadas, pool, asignacion) {
  const porId = {};
  for (const b of brigadas) {
    porId[b.id] = { ...b, colonias: [], viviendas: 0, cap: capacidadDe(b.tipo) };
  }
  for (const col of pool) {
    const id = asignacion[col.k];
    if (porId[id]) {
      porId[id].colonias.push(col);
      porId[id].viviendas += vivColonia(col);
    }
  }
  // Ordena las colonias de cada brigada por nombre, para una lista estable.
  for (const id in porId) {
    porId[id].colonias.sort((a, b) => (a.n || '').localeCompare(b.n || '', 'es'));
  }
  return brigadas.map((b) => porId[b.id]);
}

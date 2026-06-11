// Persistencia local (localStorage). En la fase 2 esto se reemplaza/complementa
// con una base de datos en la nube (Supabase) para centralizar reportes.

const KEY_REPORTES = 'geobrigada_reportes';
const KEY_PROGRESO = 'geobrigada_progreso_'; // + identificador de ruta

export function cargarReportes() {
  try {
    return JSON.parse(localStorage.getItem(KEY_REPORTES)) || [];
  } catch {
    return [];
  }
}

export function guardarReporte(reporte) {
  const todos = cargarReportes();
  todos.unshift({ ...reporte, id: Date.now().toString(36) });
  localStorage.setItem(KEY_REPORTES, JSON.stringify(todos));
}

export function borrarReporte(id) {
  const todos = cargarReportes().filter((r) => r.id !== id);
  localStorage.setItem(KEY_REPORTES, JSON.stringify(todos));
}

// Importa reportes recibidos de los brigadistas (archivos JSON compartidos
// por WhatsApp). Ignora los que ya existen (misma fecha+equipo+colonia).
export function importarReportes(nuevos) {
  const todos = cargarReportes();
  const firma = (r) => `${r.fecha}|${r.equipo}|${r.colonia}`;
  const vistas = new Set(todos.map(firma));
  let agregados = 0;
  for (const r of nuevos) {
    if (!r || !r.fecha || !r.equipo) continue;
    if (vistas.has(firma(r))) continue;
    vistas.add(firma(r));
    todos.unshift({
      ...r,
      id: (Date.parse(r.fecha) || Date.now()).toString(36) + '_eq' + r.equipo
    });
    agregados++;
  }
  localStorage.setItem(KEY_REPORTES, JSON.stringify(todos));
  return agregados;
}

// Progreso de la lista de calles del brigadista (sobrevive si recarga la página).
export function cargarProgreso(claveRuta) {
  try {
    return JSON.parse(localStorage.getItem(KEY_PROGRESO + claveRuta)) || {};
  } catch {
    return {};
  }
}

export function guardarProgreso(claveRuta, progreso) {
  localStorage.setItem(KEY_PROGRESO + claveRuta, JSON.stringify(progreso));
}

export function limpiarProgreso(claveRuta) {
  localStorage.removeItem(KEY_PROGRESO + claveRuta);
}

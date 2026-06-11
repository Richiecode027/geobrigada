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

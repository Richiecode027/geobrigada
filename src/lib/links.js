// Construcción y lectura de los links que se comparten a los brigadistas.
//
// Dos variantes:
//  - Colonia del catálogo:        ?col=<clave CVEGEO>&n=3&t=2&nombre=...
//  - Colonia dibujada a mano:     ?poly=lat,lng;lat,lng;...&n=3&t=2&nombre=...
// Como el algoritmo es determinista, el teléfono del brigadista recalcula la
// misma división de rutas que generó el coordinador, sin necesidad de servidor.

export function codificarPoly(ring) {
  return ring.map((p) => p[0].toFixed(5) + ',' + p[1].toFixed(5)).join(';');
}

export function decodificarPoly(str) {
  return str.split(';').map((par) => {
    const [lat, lng] = par.split(',').map(Number);
    return [lat, lng];
  });
}

export function linkEquipo({ colonia, nEquipos, equipo, actividad }) {
  const params = new URLSearchParams();
  if (colonia.clave) {
    params.set('col', colonia.clave);
  } else {
    params.set('poly', codificarPoly(colonia.rings[0]));
  }
  params.set('n', String(nEquipos));
  params.set('t', String(equipo));
  params.set('nombre', colonia.nombre);
  if (actividad) params.set('act', actividad);
  return `${window.location.origin}${window.location.pathname}?${params.toString()}`;
}

export function leerParametros() {
  const p = new URLSearchParams(window.location.search);
  if (!p.get('t') || !p.get('n')) return null;
  return {
    col: p.get('col'),
    poly: p.get('poly'),
    nEquipos: parseInt(p.get('n'), 10),
    equipo: parseInt(p.get('t'), 10),
    nombre: p.get('nombre') || 'Colonia',
    // La actividad separa visitas distintas a la misma colonia
    // (folletos hoy, calendarios la próxima semana, etc.).
    actividad: p.get('act') || 'Reparto'
  };
}

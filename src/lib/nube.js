// Conexión con la nube (Supabase) — fase 2.
//
// Mientras estos dos valores estén vacíos, la app funciona igual que siempre:
// reportes locales + WhatsApp. Al llenarlos, los reportes de los brigadistas
// suben solos a la nube y el coordinador los ve en su Historial.
//
// Los valores salen del proyecto de Supabase: Project Settings → API.
// La "anon key" es pública por diseño (va en el navegador); lo que puede
// hacer está limitado por las políticas de la tabla (ver scripts/esquema-supabase.sql).

const SUPABASE_URL = 'https://pxhiafunsxkdmcplwhul.supabase.co';
const SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4aGlhZnVuc3hrZG1jcGx3aHVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDgxNTAsImV4cCI6MjA5NjcyNDE1MH0.' +
  'jl7qlsobopVgg7HBFvWjSnQ8FexBEkbK6wjvku2_zxw';

const KEY_PENDIENTES = 'geobrigada_nube_pendientes';

export function nubeConfigurada() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

function cabeceras() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
}

// El reporte local usa camelCase; la tabla usa snake_case.
function aFila(r) {
  return {
    fecha: r.fecha,
    colonia: r.colonia,
    col: r.col || null,
    poly: r.poly || null,
    equipo: r.equipo,
    n_equipos: r.nEquipos,
    km: r.km,
    porcentaje: r.porcentaje,
    entregados: r.entregados,
    notas: r.notas || '',
    recorrido: r.recorridoReal || []
  };
}

function aReporte(f) {
  return {
    id: 'nube_' + f.id,
    fecha: f.fecha,
    colonia: f.colonia,
    col: f.col,
    poly: f.poly,
    equipo: f.equipo,
    nEquipos: f.n_equipos,
    km: Number(f.km) || 0,
    porcentaje: f.porcentaje,
    entregados: f.entregados,
    notas: f.notas,
    recorridoReal: f.recorrido || [],
    delaNube: true
  };
}

export async function subirReporte(r) {
  if (!nubeConfigurada()) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/reportes`, {
      method: 'POST',
      headers: { ...cabeceras(), Prefer: 'return=minimal' },
      body: JSON.stringify(aFila(r))
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Si no había señal al terminar, el reporte espera aquí y se reintenta
// la próxima vez que la app abra con internet.
export function encolarPendiente(r) {
  try {
    const cola = JSON.parse(localStorage.getItem(KEY_PENDIENTES)) || [];
    cola.push(r);
    localStorage.setItem(KEY_PENDIENTES, JSON.stringify(cola));
  } catch {
    /* sin espacio: el reporte sigue guardado en el historial local */
  }
}

export async function subirPendientes() {
  if (!nubeConfigurada()) return 0;
  let cola;
  try {
    cola = JSON.parse(localStorage.getItem(KEY_PENDIENTES)) || [];
  } catch {
    cola = [];
  }
  if (cola.length === 0) return 0;
  const quedan = [];
  let subidos = 0;
  for (const r of cola) {
    if (await subirReporte(r)) subidos++;
    else quedan.push(r);
  }
  localStorage.setItem(KEY_PENDIENTES, JSON.stringify(quedan));
  return subidos;
}

export async function cargarReportesNube() {
  if (!nubeConfigurada()) return [];
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/reportes?select=*&order=creado.desc&limit=500`,
    { headers: cabeceras() }
  );
  if (!res.ok) throw new Error('la nube respondió ' + res.status);
  return (await res.json()).map(aReporte);
}

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
    actividad: r.actividad || 'Reparto',
    campana: r.campana || null,
    brigada: r.brigada || null,
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
    actividad: f.actividad || 'Reparto',
    campana: f.campana || '',
    brigada: f.brigada || '',
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

// ---------- posiciones en vivo (una fila por equipo, se va actualizando) ----

export async function subirPosicion(p) {
  if (!nubeConfigurada()) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/posiciones`, {
      method: 'POST',
      headers: { ...cabeceras(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ ...p, actualizado: new Date().toISOString() })
    });
  } catch {
    /* sin señal: la posición simplemente no se reporta esta vez */
  }
}

export async function cargarPosiciones(minutos = 30) {
  if (!nubeConfigurada()) return [];
  const desde = new Date(Date.now() - minutos * 60000).toISOString();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/posiciones?actualizado=gte.${desde}&select=*&order=equipo.asc`,
    { headers: cabeceras() }
  );
  if (!res.ok) throw new Error('la nube respondió ' + res.status);
  return res.json();
}

// ---------- rastro nativo (jul 2026) -----------------------------------------
// Puntos que el GPS mandó directo desde Android nativo (sin pasar por esta
// app) mientras el brigadista la tenía cerrada. Ver netlify/functions/
// gps-relay.js y el "relleno" al reabrir en Brigadista.jsx.

export async function leerRastroNativo(ruta, desde) {
  if (!nubeConfigurada()) return [];
  try {
    const filtroFecha = desde ? `&creado=gt.${encodeURIComponent(desde)}` : '';
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/rastro_nativo?ruta=eq.${encodeURIComponent(ruta)}` +
        `${filtroFecha}&select=lat,lng,creado&order=creado.asc&limit=2000`,
      { headers: cabeceras() }
    );
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

// ---------- bardas (jul 2026) ------------------------------------------------
// El catálogo de bardas vive en public/bardas.json (no cambia en la jornada);
// aquí solo se guarda el RESULTADO de cada visita, para que todos los equipos
// sepan cuáles ya se preguntaron y no se repita el trabajo.

export async function cargarPermisosBardas() {
  if (!nubeConfigurada()) return [];
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/bardas_permisos?select=*&order=actualizado.desc&limit=2000`,
    { headers: cabeceras() }
  );
  if (!res.ok) throw new Error('la nube respondió ' + res.status);
  return res.json();
}

// Una fila por barda: si se vuelve a visitar, se actualiza la misma
// (merge-duplicates sobre la llave primaria barda_id).
export async function guardarPermisoBarda(p) {
  if (!nubeConfigurada()) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bardas_permisos`, {
      method: 'POST',
      headers: { ...cabeceras(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ ...p, anulado: false, actualizado: new Date().toISOString() })
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Deshacer un registro equivocado: la barda vuelve a contar como pendiente.
// No se borra la fila (la tabla no permite DELETE desde el teléfono, a
// propósito): se marca como anulada, dejando el rastro de que existió.
export async function anularPermisoBarda(bardaId) {
  if (!nubeConfigurada()) return false;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/bardas_permisos?barda_id=eq.${encodeURIComponent(bardaId)}`,
      {
        method: 'PATCH',
        headers: { ...cabeceras(), Prefer: 'return=minimal' },
        body: JSON.stringify({ anulado: true, actualizado: new Date().toISOString() })
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- bardas agregadas desde el celular (jul 2026) --------------------
// A diferencia del catálogo (viene del Excel, no cambia en la jornada), estas
// las da de alta cualquier equipo desde la propia app: encontró una barda que
// nadie había capturado, le toma foto (opcional) y la sube con su GPS.

export async function subirFotoBardaNueva(id, blob) {
  if (!nubeConfigurada()) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/bardas-fotos-nuevas/${id}.jpg`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'image/jpeg'
      },
      body: blob
    });
    if (!res.ok) return null;
    return `${SUPABASE_URL}/storage/v1/object/public/bardas-fotos-nuevas/${id}.jpg`;
  } catch {
    return null;
  }
}

export async function guardarBardaNueva(fila) {
  if (!nubeConfigurada()) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bardas_nuevas`, {
      method: 'POST',
      headers: { ...cabeceras(), Prefer: 'return=minimal' },
      body: JSON.stringify(fila)
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function cargarBardasNuevas() {
  if (!nubeConfigurada()) return [];
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/bardas_nuevas?select=*&order=creado.desc&limit=1000`,
    { headers: cabeceras() }
  );
  if (!res.ok) throw new Error('la nube respondió ' + res.status);
  return res.json();
}

// ---------- reservas de bardas (jul 2026) ------------------------------------
// Evita que dos equipos calculen la MISMA ruta si arrancan al mismo tiempo:
// al armar su recorrido, cada equipo aparta esas bardas por unas horas.

const RESERVA_HORAS = 3;

export async function cargarReservasBardas() {
  if (!nubeConfigurada()) return [];
  const ahora = new Date().toISOString();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/bardas_reservadas?vence=gt.${ahora}&select=barda_id,equipo,vence`,
    { headers: cabeceras() }
  );
  if (!res.ok) throw new Error('la nube respondió ' + res.status);
  return res.json();
}

export async function reservarBardas(ids, equipo) {
  if (!nubeConfigurada() || ids.length === 0) return;
  const vence = new Date(Date.now() + RESERVA_HORAS * 3600000).toISOString();
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/bardas_reservadas`, {
      method: 'POST',
      headers: { ...cabeceras(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(ids.map((barda_id) => ({ barda_id: String(barda_id), equipo: equipo || null, vence })))
    });
  } catch {
    /* si falla, la ruta se calculó igual; en el peor caso otro equipo se topa con las mismas bardas */
  }
}

// ---------- caché de calles compartido --------------------------------------
// El primer teléfono que descarga una colonia de OpenStreetMap la guarda aquí;
// los demás la leen de Supabase (rápido y confiable aunque OSM esté saturado).

const CACHE_CALLES_DIAS = 30;

// maxDias = null lee la copia aunque esté vieja (salvavidas cuando OSM falla).
export async function leerCallesNube(clave, maxDias = CACHE_CALLES_DIAS) {
  if (!nubeConfigurada()) return null;
  try {
    const filtroFecha = maxDias
      ? `&actualizado=gte.${new Date(Date.now() - maxDias * 86400000).toISOString()}`
      : '';
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/calles_cache?clave=eq.${encodeURIComponent(clave)}` +
        `${filtroFecha}&select=ways`,
      { headers: cabeceras() }
    );
    if (!res.ok) return null;
    const filas = await res.json();
    return filas.length > 0 ? filas[0].ways : null;
  } catch {
    return null;
  }
}

export async function guardarCallesNube(clave, ways) {
  if (!nubeConfigurada()) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/calles_cache`, {
      method: 'POST',
      headers: { ...cabeceras(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ clave, ways, actualizado: new Date().toISOString() })
    });
  } catch {
    /* el caché compartido es opcional */
  }
}

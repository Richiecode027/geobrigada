// Recibe los puntos de GPS que el plugin manda DIRECTO desde Android nativo,
// sin pasar por el JavaScript de la app (ver src/lib/gps.js): esto es lo que
// permite que el rastro siga llegando aunque el brigadista cierre la app a
// medio camino. El teléfono no puede mandarle a Supabase el encabezado de
// autenticación que exige (el plugin solo hace un POST sencillo), así que
// esta función se lo agrega y reenvía el punto a la tabla rastro_nativo.
//
// Se llama con ?ruta=<claveRuta>, el mismo identificador que arma
// Brigadista.jsx para guardar/leer el progreso localmente; así, al reabrir
// la app, se puede buscar en esa tabla lo que llegó mientras estuvo cerrada.

const SUPABASE_URL = 'https://pxhiafunsxkdmcplwhul.supabase.co';
const SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4aGlhZnVuc3hrZG1jcGx3aHVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDgxNTAsImV4cCI6MjA5NjcyNDE1MH0.' +
  'jl7qlsobopVgg7HBFvWjSnQ8FexBEkbK6wjvku2_zxw';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const ruta = url.searchParams.get('ruta');
  if (!ruta) {
    return new Response('Falta el parámetro "ruta"', { status: 400 });
  }

  let punto;
  try {
    punto = await req.json();
  } catch {
    return new Response('JSON inválido', { status: 400 });
  }

  const lat = Number(punto.latitude);
  const lng = Number(punto.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return new Response('Punto sin coordenadas válidas', { status: 400 });
  }

  const fila = {
    ruta,
    lat,
    lng,
    creado: punto.time ? new Date(punto.time).toISOString() : new Date().toISOString()
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rastro_nativo`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(fila)
  });

  if (!res.ok) {
    return new Response('Supabase respondió ' + res.status, { status: 502 });
  }
  return new Response(null, { status: 204 });
};

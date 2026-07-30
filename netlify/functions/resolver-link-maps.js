// Resuelve un link de Google Maps (corto o largo) a coordenadas.
//
// Por qué existe: al agregar una barda nueva desde el celular, el equipo
// puede pegar el link que Google Maps genera con "Compartir ubicación" — casi
// siempre es un link CORTO (maps.app.goo.gl/...) que solo trae las
// coordenadas después de seguir la redirección. El navegador no puede leer
// esa redirección él solo (CORS bloquea leer el encabezado Location de un
// dominio ajeno), así que esta función lo hace del lado del servidor — la
// misma idea que ya usa scripts/build-bardas.mjs para el Excel, pero
// disponible para la app en vivo.
//
// Uso: GET /.netlify/functions/resolver-link-maps?url=<link>
// Responde { lat, lng } o 422 si el link no trae coordenadas.

function dmsADecimal(g, m, s, hemisferio) {
  const v = Number(g) + Number(m) / 60 + Number(s) / 3600;
  return hemisferio === 'S' || hemisferio === 'W' ? -v : v;
}

function decodificarSeguro(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    /* sigue abajo */
  }
  try {
    return decodeURIComponent(s.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
  } catch {
    return s;
  }
}

function coordsDeUrl(url) {
  if (!url) return null;
  const marcador = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (marcador) return [Number(marcador[1]), Number(marcador[2])];
  const dms = decodificarSeguro(url).match(
    /(\d+)°(\d+)'([\d.]+)"([NS])\+(\d+)°(\d+)'([\d.]+)"([EW])/
  );
  if (dms) {
    return [
      dmsADecimal(dms[1], dms[2], dms[3], dms[4]),
      dmsADecimal(dms[5], dms[6], dms[7], dms[8])
    ];
  }
  const arroba = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (arroba) return [Number(arroba[1]), Number(arroba[2])];
  return null;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export default async (req) => {
  const url = new URL(req.url);
  const link = url.searchParams.get('url');
  if (!link || !/^https?:\/\//.test(link)) {
    return new Response(JSON.stringify({ error: 'Falta el link.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let actual = link;
  for (let salto = 0; salto < 5; salto++) {
    let res;
    try {
      res = await fetch(actual, { redirect: 'manual', headers: { 'User-Agent': UA } });
    } catch {
      return new Response(JSON.stringify({ error: 'No se pudo abrir el link.' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    const destino = res.headers.get('location');
    const coords = coordsDeUrl(destino) || coordsDeUrl(res.url) || coordsDeUrl(actual);
    if (coords) {
      return new Response(JSON.stringify({ lat: coords[0], lng: coords[1] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (res.status >= 300 && res.status < 400 && destino) {
      actual = new URL(destino, actual).href;
      continue;
    }
    break;
  }

  return new Response(JSON.stringify({ error: 'El link no trae coordenadas.' }), {
    status: 422,
    headers: { 'Content-Type': 'application/json' }
  });
};

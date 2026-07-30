// Coordenadas a partir de un link de Google Maps (como los que traía el
// Excel de bardas). Los links LARGOS ya traen las coordenadas en la URL y se
// leen directo aquí; los CORTOS (maps.app.goo.gl/...) hay que resolverlos del
// lado del servidor — el navegador no puede leer a dónde redirige un dominio
// ajeno (CORS) — por eso se llama a netlify/functions/resolver-link-maps.js,
// que hace lo mismo que ya hacía scripts/build-bardas.mjs para el Excel.

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

export async function coordsDeLinkMaps(link) {
  const url = link.trim();
  if (!/^https?:\/\//.test(url)) {
    throw new Error('Pega un link que empiece con http:// o https://');
  }
  const directo = coordsDeUrl(url);
  if (directo) return directo;

  const res = await fetch('/.netlify/functions/resolver-link-maps?url=' + encodeURIComponent(url));
  const datos = await res.json().catch(() => ({}));
  if (!res.ok || datos.lat == null) {
    throw new Error(datos.error || 'No se pudo leer la ubicación de ese link.');
  }
  return [datos.lat, datos.lng];
}

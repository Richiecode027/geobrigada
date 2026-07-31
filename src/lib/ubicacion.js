// Rellena solos los datos de una barda nueva a partir de dónde está parado el
// equipo: colonia, distrito y calle. Así el que la captura solo teclea el
// número, que es lo único que la ubicación no puede saber.
//
// De dónde sale cada dato:
//  - COLONIA: del catálogo del INEGI que ya trae la app
//    (public/colonias_morelia.json). Es local: funciona sin internet y son los
//    límites oficiales, mejor que lo que contestaría un servicio de mapas.
//  - DISTRITO: del trazo OFICIAL del INE (public/distritos_morelia.json). Es
//    local y exacto. Si el punto cae fuera del municipio de Morelia se recurre
//    al método viejo: deducirlo del propio catálogo de bardas, por nombre de
//    colonia y si no por la barda conocida más cercana.
//  - CALLE: de OpenStreetMap (Nominatim). Requiere internet. El número casi
//    nunca está cargado en Morelia, así que ese se escribe a mano.

import { haversine } from './geo.js';
import { coloniaEnPunto } from './colonias.js';
import { distritoEnPunto } from './distritos.js';

const normalizar = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// colonia -> distrito, armado con las bardas que YA traen distrito.
function mapaDeDistritos(bardas) {
  const m = new Map();
  for (const b of bardas || []) {
    if (!b.distrito || !b.colonia) continue;
    const k = normalizar(b.colonia);
    if (!m.has(k)) m.set(k, String(b.distrito));
  }
  return m;
}

// A cuántos metros como máximo se acepta el distrito de la barda vecina. Más
// lejos que esto la suposición ya no es seria y es mejor dejarlo en blanco.
const MAX_METROS_VECINA = 2500;

export function distritoAproximado(lat, lng, colonia, bardas) {
  if (colonia) {
    const porNombre = mapaDeDistritos(bardas).get(normalizar(colonia));
    if (porNombre) return { distrito: porNombre, segun: 'la colonia' };
  }
  let mejor = null;
  for (const b of bardas || []) {
    if (!b.distrito || b.lat == null) continue;
    const d = haversine([lat, lng], [b.lat, b.lng]);
    if (!mejor || d < mejor.d) mejor = { d, distrito: String(b.distrito) };
  }
  if (mejor && mejor.d <= MAX_METROS_VECINA) {
    return { distrito: mejor.distrito, segun: 'la barda más cercana' };
  }
  return { distrito: '', segun: null };
}

// Calle según OpenStreetMap. Devuelve '' si no hay internet o no la conoce:
// no es motivo para detener la captura.
export async function calleAproximada(lat, lng) {
  try {
    const url =
      'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1' +
      `&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'es' } });
    if (!res.ok) return '';
    const j = await res.json();
    const dir = j.address || {};
    const calle = dir.road || dir.pedestrian || dir.residential || '';
    // Si por suerte sí trae número, se aprovecha.
    return calle && dir.house_number ? `${calle} ${dir.house_number}` : calle;
  } catch {
    return '';
  }
}

// Todo junto. La colonia y el distrito salen al instante (son locales); la
// calle puede tardar o no llegar.
export async function ubicacionAproximada(lat, lng, bardas) {
  let colonia = '';
  try {
    const c = await coloniaEnPunto(lat, lng);
    colonia = c?.n || '';
  } catch {
    /* sin catálogo: se queda en blanco */
  }
  // El distrito ya no se adivina: se consulta el trazo oficial del INE. La
  // deducción vieja (por colonia o barda vecina) queda solo de respaldo, para
  // un punto que caiga fuera del municipio o si el catálogo no cargó.
  let distrito = '';
  let segun = null;
  try {
    const oficial = await distritoEnPunto(lat, lng);
    if (oficial != null) {
      distrito = String(oficial);
      segun = 'el mapa oficial del INE';
    }
  } catch {
    /* sin catálogo: se usa el respaldo de abajo */
  }
  if (!distrito) {
    const aprox = distritoAproximado(lat, lng, colonia, bardas);
    distrito = aprox.distrito;
    segun = aprox.segun;
  }

  const calle = await calleAproximada(lat, lng);
  return { colonia, distrito, distritoSegun: segun, calle };
}

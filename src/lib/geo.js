// Utilidades geográficas. Todos los puntos se manejan como [lat, lng].

const R = 6371000; // radio terrestre en metros
const toRad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const la1 = toRad(a[0]);
  const la2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function polylineLength(coords) {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += haversine(coords[i - 1], coords[i]);
  return s;
}

// Ray casting: ¿está el punto dentro del anillo?
export function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1];
    const yj = ring[j][0], xj = ring[j][1];
    const intersect =
      (xi > pt[1]) !== (xj > pt[1]) &&
      pt[0] < ((yj - yi) * (pt[1] - xi)) / (xj - xi) + yi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInAnyRing(pt, rings) {
  return rings.some((r) => pointInRing(pt, r));
}

// Proyección plana local (suficiente para distancias perpendiculares cortas).
function toXY(p, lat0) {
  return [p[1] * 111320 * Math.cos(toRad(lat0)), p[0] * 110540];
}

function perpDist(p, a, b, lat0) {
  const [px, py] = toXY(p, lat0);
  const [ax, ay] = toXY(a, lat0);
  const [bx, by] = toXY(b, lat0);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Distancia en metros de un punto al borde más cercano de los anillos.
export function distanciaABorde(pt, rings) {
  let min = Infinity;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const d = perpDist(pt, r[j], r[i], pt[0]);
      if (d < min) min = d;
    }
  }
  return min;
}

// Douglas-Peucker: simplifica un anillo para que la consulta a Overpass no sea enorme.
export function simplifyRing(ring, tolMeters = 12) {
  if (ring.length <= 4) return ring;
  const lat0 = ring[0][0];
  const keep = new Array(ring.length).fill(false);
  keep[0] = keep[ring.length - 1] = true;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, maxI = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(ring[i], ring[s], ring[e], lat0);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tolMeters) {
      keep[maxI] = true;
      stack.push([s, maxI], [maxI, e]);
    }
  }
  const out = ring.filter((_, i) => keep[i]);
  // Overpass exige al menos 3 vértices.
  return out.length >= 3 ? out : ring;
}

// Convierte el GeoJSON de Nominatim ([lon,lat]) a anillos [lat,lng].
export function geojsonToRings(gj) {
  if (!gj) return [];
  if (gj.type === 'Polygon') {
    return [gj.coordinates[0].map(([lon, lat]) => [lat, lon])];
  }
  if (gj.type === 'MultiPolygon') {
    return gj.coordinates.map((poly) => poly[0].map(([lon, lat]) => [lat, lon]));
  }
  return [];
}

// Parte una trayectoria GPS en segmentos donde hay huecos grandes (teléfono
// bloqueado, sin señal GPS): así no se pintan líneas rectas falsas.
export function partirTrayectoria(track, gapMetros = 100) {
  if (!track || track.length < 2) return [];
  const segs = [];
  let cur = [track[0]];
  for (let i = 1; i < track.length; i++) {
    if (haversine(track[i - 1], track[i]) > gapMetros) {
      if (cur.length > 1) segs.push(cur);
      cur = [track[i]];
    } else {
      cur.push(track[i]);
    }
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}

export function ringsBounds(rings) {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const r of rings) {
    for (const [lat, lng] of r) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  }
  return [[minLat, minLng], [maxLat, maxLng]];
}

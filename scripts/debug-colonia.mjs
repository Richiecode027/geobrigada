// Depura el reparto de rutas con los datos REALES de una colonia:
//   node scripts/debug-colonia.mjs "lomas de las americas" 2
// Descarga las calles una vez y las cachea en TEMP para iterar sin saturar Overpass.

import fs from 'node:fs';
import path from 'node:path';
import { buildUnits } from '../src/lib/units.js';
import { partition, orderRoute, buildAdjacency, puntoDeEncuentro } from '../src/lib/partition.js';
import { haversine, simplifyRing } from '../src/lib/geo.js';

const nombreBuscado = (process.argv[2] || 'lomas de las americas').toLowerCase();
const k = parseInt(process.argv[3] || '2', 10);

const catalogo = JSON.parse(fs.readFileSync('public/colonias_morelia.json', 'utf8'));
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const col =
  catalogo.colonias.find((c) => norm(c.n) === norm(nombreBuscado)) ||
  catalogo.colonias.find((c) => norm(c.n).includes(norm(nombreBuscado)));
if (!col) throw new Error('Colonia no encontrada');
const rings = catalogo.polys[col.k];
console.log(`Colonia: ${col.n} (${col.k}) — ${rings.length} anillo(s)`);

const cacheFile = path.join(process.env.TEMP || '/tmp', `calles_${col.k}.json`);
let ways;
if (fs.existsSync(cacheFile)) {
  ways = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
} else {
  const clauses = rings
    .map((r) => {
      const poly = simplifyRing(r, 12)
        .map((p) => p[0].toFixed(6) + ' ' + p[1].toFixed(6))
        .join(' ');
      return `way["highway"~"^(primary|secondary|tertiary|residential|living_street|unclassified|pedestrian|service|footway)$"]["service"!~"parking_aisle|driveway|drive-through|emergency_access"](poly:"${poly}");`;
    })
    .join('\n');
  const query = `[out:json][timeout:90];(${clauses});out geom;`;
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  let json = null, lastErr = null;
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'GeoBrigada-debug' },
        body: 'data=' + encodeURIComponent(query)
      });
      if (!res.ok) throw new Error('Overpass ' + res.status + ' en ' + ep);
      json = await res.json();
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!json) throw lastErr;
  ways = json.elements.filter((e) => e.type === 'way' && e.geometry);
  fs.writeFileSync(cacheFile, JSON.stringify(ways));
}
console.log(`Calles (ways): ${ways.length}`);

const units = buildUnits(ways, rings);
console.log(`Tramos (units): ${units.length}`);

// Componentes de la red completa
const ady = buildAdjacency(units);
const compDe = new Array(units.length).fill(-1);
let nComp = 0;
for (let i = 0; i < units.length; i++) {
  if (compDe[i] !== -1) continue;
  const cola = [i];
  compDe[i] = nComp;
  while (cola.length) {
    for (const v of ady[cola.pop()]) {
      if (compDe[v] === -1) { compDe[v] = nComp; cola.push(v); }
    }
  }
  nComp++;
}
const tamComp = Array.from({ length: nComp }, () => 0);
for (let i = 0; i < units.length; i++) tamComp[compDe[i]] += units[i].length;
console.log(
  `Componentes de la red: ${nComp} — km por componente: [${tamComp.map((t) => (t / 1000).toFixed(2)).join(', ')}]`
);

// Reparto
const grupos = partition(units, k);
const inicio = puntoDeEncuentro(units);

// Centroides por zona, para medir tramos "fuera de lugar"
const centros = grupos.map((g) => {
  let sLat = 0, sLng = 0, sW = 0;
  for (const u of g) { sLat += u.mid[0] * u.length; sLng += u.mid[1] * u.length; sW += u.length; }
  return [sLat / sW, sLng / sW];
});
grupos.forEach((g, i) => {
  const km = g.reduce((s, u) => s + u.length, 0) / 1000;
  // componentes internas de la zona
  const adyG = buildAdjacency(g);
  const visto = new Array(g.length).fill(false);
  let piezas = 0;
  for (let a = 0; a < g.length; a++) {
    if (visto[a]) continue;
    piezas++;
    const cola = [a];
    visto[a] = true;
    while (cola.length) {
      for (const v of adyG[cola.pop()]) {
        if (!visto[v]) { visto[v] = true; cola.push(v); }
      }
    }
  }
  const ruta = orderRoute(g, inicio);
  let saltoMax = 0;
  for (let j = 1; j < ruta.length; j++) {
    const fin = ruta[j - 1].coords[ruta[j - 1].coords.length - 1];
    const ini = ruta[j].coords[0];
    saltoMax = Math.max(saltoMax, haversine(fin, ini));
  }
  // tramos mucho más cerca del corazón de otra zona que del propio (tentáculos)
  let fueraDeLugar = 0;
  for (const u of g) {
    const dPropio = haversine(u.mid, centros[i]);
    for (let s = 0; s < centros.length; s++) {
      if (s !== i && haversine(u.mid, centros[s]) < dPropio * 0.6) { fueraDeLugar++; break; }
    }
  }
  console.log(
    `Equipo ${i + 1}: ${km.toFixed(1)} km · ${g.length} tramos · ${piezas} pieza(s) · salto máx ${Math.round(saltoMax)} m · fuera de lugar: ${fueraDeLugar}`
  );
});

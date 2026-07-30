// Convierte el Excel de bardas (el que llena quien anda buscándolas en carro)
// en public/bardas.json, que es lo que lee la app.
//
// El Excel trae la ubicación como LINK CORTO de Google Maps
// (https://maps.app.goo.gl/...), no como coordenadas. Este script abre cada
// link una vez y saca las coordenadas reales, para poder pintarlas en el mapa
// y armar rutas. Es lento (una petición por barda) pero se corre una sola vez
// por archivo; los links ya resueltos se recuerdan en caché.
//
// Uso:
//   node scripts/build-bardas.mjs "C:/ruta/BARDAS BRIGADA 1.xlsx"
//
// Requiere: npm i -D xlsx

import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const archivo = process.argv[2];
if (!archivo) {
  console.error('Falta el archivo. Uso: node scripts/build-bardas.mjs "<ruta al .xlsx>"');
  process.exit(1);
}

const SALIDA = 'public/bardas.json';
const CACHE = path.join(process.env.TEMP || '/tmp', 'bardas_coords_cache.json');
// Pausa entre peticiones, por cortesía con el servidor de Google. Solo se pide
// la cabecera de redirección (no la página), así que no hace falta ir muy lento.
const PAUSA_MS = 350;

// --- acentos: el Excel viene con doble codificación ("UniÃ³n" por "Unión") ---
function arreglarAcentos(s) {
  if (typeof s !== 'string' || !/[ÃÂ]/.test(s)) return s;
  try {
    const fix = Buffer.from(s, 'latin1').toString('utf8');
    return /\uFFFD/.test(fix) ? s : fix; // si sale peor, se deja como estaba
  } catch {
    return s;
  }
}

const limpiar = (v) => arreglarAcentos(String(v ?? '').trim());

// --- coordenadas: resolver el link corto de Google Maps ---------------------
// La URL final trae el punto marcado como grados ("place/19°42'31.8\"N+...")
// y la posición de la cámara como "@lat,lng". Se prefiere el punto marcado.
function dmsADecimal(g, m, s, hemisferio) {
  const v = Number(g) + Number(m) / 60 + Number(s) / 3600;
  return hemisferio === 'S' || hemisferio === 'W' ? -v : v;
}

// Algunas URLs de Google traen un % suelto (p. ej. al final de "data=…!100%")
// que rompe decodeURIComponent y tiraría toda la barda. Se escapan esos %
// inválidos y se vuelve a intentar, para no perder las coordenadas.
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
  // 1) "!3d<lat>!4d<lng>": el punto exacto del marcador (lo más preciso).
  const marcador = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (marcador) return [Number(marcador[1]), Number(marcador[2])];
  // 2) El nombre del lugar en grados ("place/19°42'29.5\"N+101°09'23.8\"W").
  const dms = decodificarSeguro(url).match(
    /(\d+)°(\d+)'([\d.]+)"([NS])\+(\d+)°(\d+)'([\d.]+)"([EW])/
  );
  if (dms) {
    return [
      dmsADecimal(dms[1], dms[2], dms[3], dms[4]),
      dmsADecimal(dms[5], dms[6], dms[7], dms[8])
    ];
  }
  // 3) "@lat,lng": el centro de la cámara (aproximado, último recurso).
  const arroba = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (arroba) return [Number(arroba[1]), Number(arroba[2])];
  return null;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Si se piden muchos links seguidos, Google responde una página de captcha
// ("/sorry/") con estado 200: no es un error de red, simplemente no trae
// coordenadas. Se detecta para poder esperar y reintentar en vez de dar la
// barda por perdida.
class Bloqueado extends Error {}

// El link corto solo REDIRIGE a la URL larga, y esa URL ya trae las
// coordenadas. Se lee únicamente la cabecera de redirección (redirect:
// 'manual'), sin descargar la página del mapa: es mucho más rápido y no
// dispara el captcha de Google, que fue lo que trabó los primeros intentos.
async function resolverLink(url) {
  let actual = url;
  for (let salto = 0; salto < 5; salto++) {
    const res = await fetch(actual, { redirect: 'manual', headers: { 'User-Agent': UA } });
    const destino = res.headers.get('location');
    // Las coordenadas suelen venir ya en el primer destino.
    const coords = coordsDeUrl(destino) || coordsDeUrl(res.url);
    if (coords) return coords;
    if (res.status >= 300 && res.status < 400 && destino) {
      if (/\/sorry\//i.test(destino)) {
        throw new Bloqueado('Google pidió captcha (demasiadas peticiones seguidas)');
      }
      actual = new URL(destino, actual).href; // sigue el siguiente salto
      continue;
    }
    // Ya no redirige: como último recurso se lee el cuerpo.
    if (res.ok) {
      const cuerpo = await res.text();
      const porCuerpo = coordsDeUrl(cuerpo);
      if (porCuerpo) return porCuerpo;
      if (/\/sorry\/|unusual traffic|recaptcha/i.test(cuerpo.slice(0, 3000))) {
        throw new Bloqueado('Google pidió captcha (demasiadas peticiones seguidas)');
      }
    }
    return null; // el link existe pero no trae coordenadas
  }
  return null;
}

// Resuelve reintentando si Google bloquea: espera cada vez más (1, 2, 4… min).
async function resolverConEspera(url) {
  for (let intento = 0; intento < 4; intento++) {
    try {
      return await resolverLink(url);
    } catch (e) {
      if (!(e instanceof Bloqueado) || intento === 3) throw e;
      const espera = 60000 * Math.pow(2, intento);
      console.log(
        `\n  Google pidió captcha; esperando ${espera / 60000} min y reintentando…`
      );
      await new Promise((s) => setTimeout(s, espera));
    }
  }
}

// --- lee el Excel -----------------------------------------------------------
console.log('Leyendo', path.basename(archivo), '…');
const wb = XLSX.readFile(archivo);
const hoja = wb.SheetNames[0];
const filas = XLSX.utils.sheet_to_json(wb.Sheets[hoja], { header: 1, defval: '' });

// Encabezados esperados: NO. | Marca temporal | BRIGADA | DIRECCION | COLONIA |
//                        DISTRITO | FOTO | REFERENCIAS
const cab = filas[0].map((h) => limpiar(h).toUpperCase());
const col = (nombre) => cab.findIndex((h) => h.startsWith(nombre));
const iNo = col('NO'), iBrig = col('BRIGADA'), iDir = col('DIRECCION');
const iCol = col('COLONIA'), iDis = col('DISTRITO'), iRef = col('REFERENCIAS');

const datos = filas.slice(1).filter((r) => String(r[iNo] ?? '').trim() !== '');
console.log('Bardas en el archivo:', datos.length);

// --- caché de links ya resueltos (para no repetir peticiones) ---------------
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
} catch {
  /* primera vez */
}

const bardas = [];
let resueltas = 0, deCache = 0, sinUbicacion = 0, fallidas = 0;

for (const r of datos) {
  const ref = limpiar(r[iRef]);
  const esLink = /maps\.app\.goo\.gl|google\.[a-z.]+\/maps/.test(ref);

  let coords = null;
  if (esLink) {
    if (cache[ref]) {
      coords = cache[ref];
      deCache++;
    } else {
      try {
        coords = await resolverConEspera(ref);
        if (coords) {
          cache[ref] = coords;
          resueltas++;
          fs.writeFileSync(CACHE, JSON.stringify(cache)); // guarda sobre la marcha
        } else {
          fallidas++;
        }
      } catch (e) {
        fallidas++;
        console.warn('  no se pudo resolver la barda', r[iNo], '(' + e.message + ')');
      }
      await new Promise((s) => setTimeout(s, PAUSA_MS));
    }
  } else {
    sinUbicacion++;
  }

  bardas.push({
    id: String(r[iNo]).trim(),
    brigada: limpiar(r[iBrig]),
    direccion: limpiar(r[iDir]),
    colonia: limpiar(r[iCol]),
    distrito: limpiar(r[iDis]),
    // Sin coordenadas la barda no se puede pintar ni ruteo: se marca aparte.
    lat: coords ? +coords[0].toFixed(6) : null,
    lng: coords ? +coords[1].toFixed(6) : null,
    // El link de Drive de la columna FOTO no se guarda aquí (no es una imagen
    // que la app pueda mostrar directo). Las fotos reales, si el Excel las
    // trae incrustadas en celda, se agregan aparte con
    // scripts/agregar-fotos-bardas.mjs.
    foto: null,
    // La referencia se conserva: si no hubo coordenadas, al menos el brigadista
    // puede abrir el link o leer la referencia escrita a mano.
    referencia: ref || null
  });

  if ((resueltas + deCache) % 20 === 0 && (resueltas + deCache) > 0) {
    process.stdout.write(`  ${resueltas + deCache}/${datos.length}\r`);
  }
}

const conCoords = bardas.filter((b) => b.lat != null).length;
fs.mkdirSync('public', { recursive: true });
fs.writeFileSync(
  SALIDA,
  JSON.stringify({
    generado: new Date().toISOString().slice(0, 10),
    fuente: path.basename(archivo),
    bardas
  })
);

const kb = Math.round(fs.statSync(SALIDA).size / 1024);
console.log('\n--------------------------------------------------');
console.log(`Resueltas ahora: ${resueltas} · de caché: ${deCache} · sin link: ${sinUbicacion} · fallidas: ${fallidas}`);
console.log(`Bardas con coordenadas: ${conCoords} de ${bardas.length}`);
console.log(`Archivo: ${SALIDA} (${kb} KB)`);

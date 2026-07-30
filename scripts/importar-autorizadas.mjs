// Marca en la nube las bardas que YA se autorizaron, tomándolas del Excel
// "RELACION DE BARDAS AUTORIZADAS" (el que llena quien va cerrando permisos).
//
// Cruza ese Excel con el catálogo (public/bardas.json) de dos formas:
//   1) Por el link de Google Maps, cuando lo trae: es exacto.
//   2) Por dirección + colonia, comparando sin acentos ni mayúsculas y sin
//      importar si el número va antes o después ("12 Burundi" = "Burundi 12").
//
// Con `--dry` solo enseña qué haría, sin tocar la nube. Sin esa bandera, sube.
//
// Uso:
//   node scripts/importar-autorizadas.mjs "<ruta al .xlsx>" [--dry]

import fs from 'node:fs';
import XLSX from 'xlsx';

const archivo = process.argv[2];
const soloVer = process.argv.includes('--dry');
if (!archivo) {
  console.error('Falta el archivo. Uso: node scripts/importar-autorizadas.mjs "<ruta>" [--dry]');
  process.exit(1);
}

const SUPABASE_URL = 'https://pxhiafunsxkdmcplwhul.supabase.co';
const SUPABASE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB4aGlhZnVuc3hrZG1jcGx3aHVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNDgxNTAsImV4cCI6MjA5NjcyNDE1MH0.' +
  'jl7qlsobopVgg7HBFvWjSnQ8FexBEkbK6wjvku2_zxw';

// --- normalización para comparar direcciones escritas por personas distintas
const sinAcentos = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// "Av. Burundi #12, esq." -> conjunto de palabras + números sueltos, para que
// "12 Burundi" y "Burundi 12" se parezcan aunque el orden cambie.
function fichaTexto(s) {
  const limpio = sinAcentos(s)
    .replace(/[#.,;:()"']/g, ' ')
    .replace(/\b(no|num|numero|calle|av|avenida|esq|esquina|col|colonia|de|del|la|el|los|las|y|con|a)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return new Set(limpio.split(' ').filter((p) => p.length > 1));
}

// Qué tanto se parecen dos direcciones (0 a 1).
function parecido(a, b) {
  const fa = fichaTexto(a), fb = fichaTexto(b);
  if (fa.size === 0 || fb.size === 0) return 0;
  let comunes = 0;
  for (const p of fa) if (fb.has(p)) comunes++;
  return comunes / Math.min(fa.size, fb.size);
}

const idDeLink = (s) => {
  const m = String(s || '').match(/goo\.gl\/([A-Za-z0-9]+)/);
  return m ? m[1] : null;
};

// --- lee el catálogo y el Excel ---------------------------------------------
const catalogo = JSON.parse(fs.readFileSync('public/bardas.json', 'utf8')).bardas;
const porLink = new Map();
for (const b of catalogo) {
  const id = idDeLink(b.referencia);
  if (id) porLink.set(id, b);
}

const wb = XLSX.readFile(archivo);
const filas = XLSX.utils.sheet_to_json(wb.Sheets['BARDAS'], { header: 1, defval: '' });
// El encabezado real está en la fila 2 (la 1 es el título del reporte).
const datos = filas.slice(2).filter((r) => String(r[0]).trim() !== '');

console.log(`Bardas autorizadas en el Excel: ${datos.length}`);

const aSubir = [];
const sinCruce = [];
const dudosas = [];

for (const r of datos) {
  const [, , nombre, telefono, direccion, colonia, referencia, status] = r;
  if (!/autoriz/i.test(String(status))) continue; // solo las autorizadas

  // 1) por link (exacto)
  let barda = porLink.get(idDeLink(referencia));
  let como = 'link';

  // 2) por dirección + colonia
  if (!barda) {
    let mejor = null, mejorPunt = 0;
    for (const b of catalogo) {
      const pDir = parecido(direccion, b.direccion);
      const pCol = parecido(colonia, b.colonia);
      // La colonia tiene que coincidir razonablemente; la dirección manda.
      if (pCol < 0.5) continue;
      const punt = pDir * 0.8 + pCol * 0.2;
      if (punt > mejorPunt) { mejorPunt = punt; mejor = b; }
    }
    // Se exige mucho parecido: marcar la barda equivocada como autorizada
    // sería peor que dejarla pendiente (nadie volvería a preguntar ahí).
    if (mejorPunt >= 0.95) {
      barda = mejor;
      como = `dirección (${Math.round(mejorPunt * 100)}%)`;
    } else if (mejorPunt >= 0.6) {
      dudosas.push(
        `  #${r[0]} "${direccion}" · ${colonia}\n` +
          `      se parece a la barda ${mejor.id} "${mejor.direccion}" (${Math.round(mejorPunt * 100)}%), pero no lo suficiente`
      );
      continue;
    }
  }

  if (!barda) {
    sinCruce.push({ fila: r[0], direccion, colonia, referencia, nombre, telefono });
    continue;
  }

  const limpiar = (v) => {
    const s = String(v || '').trim();
    return s && !/^no lo dio$/i.test(s) ? s : null;
  };

  aSubir.push({
    fila: r[0],
    barda_id: String(barda.id),
    catalogo: `${barda.direccion} · ${barda.colonia}`,
    como,
    datos: {
      barda_id: String(barda.id),
      permiso: true,
      nombre: limpiar(nombre),
      telefono: limpiar(telefono),
      notas: 'Autorizada (cargada del Excel de bardas autorizadas)',
      equipo: null,
      anulado: false,
      actualizado: new Date().toISOString()
    }
  });
}

console.log(`\nCruzadas: ${aSubir.length} · nuevas: ${sinCruce.length} · dudosas: ${dudosas.length}`);
for (const a of aSubir) {
  console.log(`  #${a.fila} -> barda ${a.barda_id} (${a.como}) · ${a.catalogo}`);
}
if (dudosas.length) {
  console.log('\n⚠ DUDOSAS: se parecen a una del catálogo pero no lo bastante.');
  console.log('  No se tocan (marcarlas mal dejaría una barda sin visitar). Revísalas a mano:');
  dudosas.forEach((s) => console.log(s));
}

// --- bardas que no estaban en el catálogo: se agregan (con sus coordenadas) --
// Son bardas autorizadas que se capturaron después del Excel original; si no
// se agregan, no saldrían nunca en el mapa ni en las rutas.
const nuevas = [];
if (sinCruce.length) {
  console.log('\nNo estaban en el catálogo; resolviendo su ubicación…');
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const dec = (s) => {
    try { return decodeURIComponent(s); } catch {}
    try { return decodeURIComponent(s.replace(/%(?![0-9A-Fa-f]{2})/g, '%25')); } catch { return s; }
  };
  const coordsDe = (u) => {
    if (!u) return null;
    const m = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (m) return [+m[1], +m[2]];
    const d = dec(u).match(/(\d+)°(\d+)'([\d.]+)"([NS])\+(\d+)°(\d+)'([\d.]+)"([EW])/);
    if (d) {
      const f = (g, mi, s, h) => {
        const v = +g + +mi / 60 + +s / 3600;
        return h === 'S' || h === 'W' ? -v : v;
      };
      return [f(d[1], d[2], d[3], d[4]), f(d[5], d[6], d[7], d[8])];
    }
    const a = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    return a ? [+a[1], +a[2]] : null;
  };

  // Los ids nuevos siguen al mayor que ya exista, para no pisar ninguno.
  let siguienteId = Math.max(...catalogo.map((b) => parseInt(b.id, 10) || 0)) + 1;

  for (const s of sinCruce) {
    let coords = null;
    const link = String(s.referencia || '').trim();
    if (/maps\.app\.goo\.gl|google\.[a-z.]+\/maps/.test(link)) {
      try {
        const res = await fetch(link, { redirect: 'manual', headers: { 'User-Agent': UA } });
        coords = coordsDe(res.headers.get('location')) || coordsDe(res.url);
      } catch {
        /* sin ubicación: se agrega igual, se buscará por dirección */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const id = String(siguienteId++);
    nuevas.push({
      id,
      brigada: '',
      direccion: String(s.direccion || '').trim(),
      colonia: String(s.colonia || '').trim(),
      distrito: '',
      lat: coords ? +coords[0].toFixed(6) : null,
      lng: coords ? +coords[1].toFixed(6) : null,
      foto: null,
      referencia: link || null
    });
    console.log(
      `  #${s.fila} "${s.direccion}" -> barda ${id} ${coords ? '(ubicada)' : '(SIN ubicación)'}`
    );
    // También queda marcada como autorizada.
    const limpiarV = (v) => {
      const t = String(v || '').trim();
      return t && !/^no lo dio$/i.test(t) ? t : null;
    };
    aSubir.push({
      fila: s.fila,
      barda_id: id,
      catalogo: `${s.direccion} · ${s.colonia}`,
      como: 'nueva',
      datos: {
        barda_id: id,
        permiso: true,
        nombre: limpiarV(s.nombre),
        telefono: limpiarV(s.telefono),
        notas: 'Autorizada (cargada del Excel de bardas autorizadas)',
        equipo: null,
        anulado: false,
        actualizado: new Date().toISOString()
      }
    });
  }
}

// Dos filas del Excel pueden apuntar a la misma barda del catálogo: se avisa.
const vistos = new Map();
for (const a of aSubir) {
  if (vistos.has(a.barda_id)) {
    console.log(`\n⚠ Las filas #${vistos.get(a.barda_id)} y #${a.fila} apuntan a la misma barda (${a.barda_id}).`);
  }
  vistos.set(a.barda_id, a.fila);
}

if (soloVer) {
  console.log('\n(--dry: no se subió nada ni se tocó el catálogo)');
  process.exit(0);
}

// Guarda el catálogo con las bardas nuevas agregadas.
if (nuevas.length) {
  const archivoCat = 'public/bardas.json';
  const cat = JSON.parse(fs.readFileSync(archivoCat, 'utf8'));
  cat.bardas.push(...nuevas);
  fs.writeFileSync(archivoCat, JSON.stringify(cat));
  console.log(`\n📍 Catálogo actualizado: ${nuevas.length} bardas nuevas (ahora ${cat.bardas.length}).`);
  console.log('   Acuérdate de subir la versión del caché en public/sw.js.');
}

// --- sube a la nube ---------------------------------------------------------
const res = await fetch(`${SUPABASE_URL}/rest/v1/bardas_permisos`, {
  method: 'POST',
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal'
  },
  body: JSON.stringify(aSubir.map((a) => a.datos))
});
console.log(res.ok ? `\n✅ Subidas ${aSubir.length} bardas autorizadas.` : `\n❌ Error ${res.status}: ${await res.text()}`);

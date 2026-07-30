// Saca las fotos YA incrustadas en el Excel (las que arma
// empotrar-fotos-excel.mjs, ancladas cada una a su celda) y las guarda como
// archivos sueltos en public/bardas-fotos/<id>.jpg, donde <id> es el mismo
// "NO." de esa fila (el mismo id que usa public/bardas.json).
//
// A propósito NO se usa el link de Google Drive de la columna FOTO: ese
// campo se deja en null. Solo se muestran fotos que de verdad están
// incrustadas como imagen en el Excel.
//
// Uso:
//   node scripts/agregar-fotos-bardas.mjs "<ruta al Excel 'fotos en celda'>"
//
// Requiere: npm i -D xlsx adm-zip

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import XLSX from 'xlsx';

const archivo = process.argv[2];
if (!archivo) {
  console.error(
    'Falta el archivo. Uso: node scripts/agregar-fotos-bardas.mjs "<ruta al Excel \'fotos en celda\'>"'
  );
  process.exit(1);
}

const CATALOGO = 'public/bardas.json';
const CARPETA_FOTOS = 'public/bardas-fotos';
const mb = (n) => (n / 1024 / 1024).toFixed(1);

console.log(`Abriendo ${path.basename(archivo)}…`);
const zip = new AdmZip(archivo);
const leer = (n) => zip.readAsText(n);

// --- 1) dónde quedó cada foto: drawing1.xml trae la fila (xdr:row, 0-based)
// y a qué relación de imagen apunta; drawing1.xml.rels trae el archivo real.
const dibujo = leer('xl/drawings/drawing1.xml');
const posiciones = [...dibujo.matchAll(
  /<xdr:from><xdr:col>(\d+)<\/xdr:col>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>[\s\S]*?<\/xdr:from>[\s\S]*?r:embed="([^"]+)"/g
)].map((m) => ({ colNum: +m[1], filaExcel: +m[2] + 1, rId: m[3] }));

const relsDibujo = leer('xl/drawings/_rels/drawing1.xml.rels');
const idAArchivo = new Map(
  [...relsDibujo.matchAll(/<Relationship Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [
    m[1],
    path.basename(m[2])
  ])
);

console.log(`Fotos incrustadas en el Excel: ${posiciones.length}`);
if (posiciones.length === 0) {
  console.error('No se encontró xl/drawings/drawing1.xml con fotos. ¿Es el Excel ya arreglado por empotrar-fotos-excel.mjs?');
  process.exit(1);
}

// Si una fila trae 2 fotos (2 columnas), se usa solo la primera (columna más
// a la izquierda): una foto de referencia es suficiente para decidir si vale
// la pena ir, y así cada barda tiene a lo más un archivo.
const porFila = new Map();
for (const p of posiciones) {
  const actual = porFila.get(p.filaExcel);
  if (!actual || p.colNum < actual.colNum) porFila.set(p.filaExcel, p);
}

// --- 2) qué "NO." (id de la barda) tiene cada fila del Excel -----------------
const wb = XLSX.readFile(archivo);
const filas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
const cab = filas[0].map((h) => String(h ?? '').trim().toUpperCase());
const iNo = cab.findIndex((h) => h.startsWith('NO'));
if (iNo === -1) {
  console.error('No se encontró la columna "NO." en la fila de encabezados.');
  process.exit(1);
}

// --- 3) guarda cada foto como public/bardas-fotos/<id>.jpg ------------------
fs.mkdirSync(CARPETA_FOTOS, { recursive: true });
const idAFoto = new Map(); // id de barda -> nombre de archivo guardado
let guardadas = 0, sinId = 0;

for (const [filaExcel, p] of porFila) {
  const fila = filas[filaExcel - 1];
  const id = fila ? String(fila[iNo] ?? '').trim() : '';
  if (!id) {
    sinId++;
    continue;
  }
  const archivoMedia = idAArchivo.get(p.rId);
  if (!archivoMedia) continue;
  const datos = zip.getEntry('xl/media/' + archivoMedia)?.getData();
  if (!datos) continue;

  const nombre = `${id}.jpg`;
  fs.writeFileSync(path.join(CARPETA_FOTOS, nombre), datos);
  idAFoto.set(id, nombre);
  guardadas++;
}
console.log(`Fotos guardadas en ${CARPETA_FOTOS}: ${guardadas}${sinId ? ` (${sinId} filas sin "NO." válido, ignoradas)` : ''}`);

// --- 4) actualiza el catálogo: foto = ruta local, o null si no hay ----------
// Se reemplaza SIEMPRE el campo (aunque antes tuviera el link de Drive): la
// app ya no debe mostrar ese link, solo fotos incrustadas de verdad.
const cat = JSON.parse(fs.readFileSync(CATALOGO, 'utf8'));
let conFoto = 0;
for (const b of cat.bardas) {
  const nombre = idAFoto.get(String(b.id));
  b.foto = nombre ? `bardas-fotos/${nombre}` : null;
  if (nombre) conFoto++;
}
fs.writeFileSync(CATALOGO, JSON.stringify(cat));

const pesoCarpeta = fs
  .readdirSync(CARPETA_FOTOS)
  .reduce((s, f) => s + fs.statSync(path.join(CARPETA_FOTOS, f)).size, 0);

console.log('--------------------------------------------------');
console.log(`Bardas del catálogo con foto: ${conFoto} de ${cat.bardas.length}`);
console.log(`Peso de public/bardas-fotos: ${mb(pesoCarpeta)} MB`);
console.log('Acuérdate de subir la versión del caché en public/sw.js.');

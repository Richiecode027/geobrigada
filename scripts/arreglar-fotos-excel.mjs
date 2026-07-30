// Arregla un Excel cuyas fotos aparecen como "#¡DESCONOCIDO!" o "#VALUE!".
//
// Qué pasa: quien armó el archivo usó "Insertar imagen EN CELDA", una función
// nueva de Excel 365. La celda guarda el texto de error como respaldo y la foto
// va aparte; solo Excel 365 sabe juntarlos. Cualquier otra versión de Excel, y
// también Google Drive/Sheets, muestran el error.
//
// Qué hace este script: saca esas fotos y las vuelve a poner como IMÁGENES
// NORMALES (flotando sobre la hoja, ancladas a su fila), que es como se han
// insertado siempre y todas las versiones entienden. Además las guarda sueltas
// en una carpeta, por si se prefiere verlas fuera del Excel.
//
// No toca el original: escribe una copia nueva al lado.
//
// Uso:
//   node scripts/arreglar-fotos-excel.mjs "<ruta al .xlsx>"

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';

const archivo = process.argv[2];
if (!archivo) {
  console.error('Falta el archivo. Uso: node scripts/arreglar-fotos-excel.mjs "<ruta al .xlsx>"');
  process.exit(1);
}

const salida = archivo.replace(/\.xlsx$/i, '') + ' (fotos visibles).xlsx';
const carpetaFotos = archivo.replace(/\.xlsx$/i, '') + ' - fotos';
const mb = (n) => (n / 1024 / 1024).toFixed(1);

const zip = new AdmZip(archivo);
const leer = (n) => zip.readAsText(n);

// --- 1) seguir la cadena celda -> foto ---------------------------------------
// La celda dice vm="N"; ese N apunta a un bloque de metadata.xml, que apunta a
// un "rich value", que apunta a una relación, que finalmente da el archivo.
const meta = leer('xl/metadata.xml');
const bloqueValue = meta.slice(meta.indexOf('<valueMetadata'));
const vmARich = [...bloqueValue.matchAll(/<rc t="\d+" v="(\d+)"\/>/g)].map((m) => +m[1]);

const rich = leer('xl/richData/rdrichvalue.xml');
const richARel = [...rich.matchAll(/<rv[^>]*>\s*<v>(\d+)<\/v>/g)].map((m) => +m[1]);

const relLista = leer('xl/richData/richValueRel.xml');
const relIds = [...relLista.matchAll(/<rel r:id="([^"]+)"\/>/g)].map((m) => m[1]);

const relsXml = leer('xl/richData/_rels/richValueRel.xml.rels');
const idAArchivo = new Map(
  [...relsXml.matchAll(/<Relationship Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [
    m[1],
    path.basename(m[2])
  ])
);

// --- 2) qué celda (fila/columna) tiene cada foto ----------------------------
const hoja = leer('xl/worksheets/sheet1.xml');
const celdas = [...hoja.matchAll(/<c r="([A-Z]+)(\d+)"[^>]*vm="(\d+)"[^>]*>/g)].map((m) => ({
  col: m[1],
  fila: +m[2],
  vm: +m[3]
}));

const colANum = (c) => [...c].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

const fotos = [];
for (const c of celdas) {
  const iRich = vmARich[c.vm - 1]; // vm es 1-based
  const iRel = richARel[iRich];
  const archivoFoto = idAArchivo.get(relIds[iRel]);
  if (archivoFoto) fotos.push({ ...c, archivo: archivoFoto, colNum: colANum(c.col) });
}
console.log(`Fotos encontradas y ubicadas: ${fotos.length} de ${celdas.length} celdas con imagen`);
if (fotos.length === 0) {
  console.log('No se pudo seguir la pista de las fotos; el archivo no se modificó.');
  process.exit(1);
}

// --- 3) guardarlas sueltas en una carpeta -----------------------------------
// Se nombran con la fila para saber a qué barda corresponden. Una fila puede
// traer más de una foto (dos columnas), así que se agrega la columna al
// nombre: si no, la segunda pisaría a la primera y se perdería una barda.
fs.mkdirSync(carpetaFotos, { recursive: true });
const porFila = {};
for (const f of fotos) porFila[f.fila] = (porFila[f.fila] || 0) + 1;
for (const f of fotos) {
  const datos = zip.getEntry('xl/media/' + f.archivo).getData();
  const ext = path.extname(f.archivo) || '.png';
  const sufijo = porFila[f.fila] > 1 ? `_${f.col}` : '';
  fs.writeFileSync(
    path.join(carpetaFotos, `fila${String(f.fila).padStart(3, '0')}${sufijo}${ext}`),
    datos
  );
}
console.log(`Fotos guardadas sueltas en: ${carpetaFotos}`);

// --- 4) volver a insertarlas como imágenes normales --------------------------
const EMU_COL = 640080; // ancho aproximado de una columna, en unidades de Excel
const EMU_FILA = 190500; // alto aproximado de una fila
const ANCHO = EMU_COL * 3; // la foto ocupa ~3 columnas y ~8 filas: se ve bien
const ALTO = EMU_FILA * 8;

let dibujos = '';
let relsDibujo = '';
fotos.forEach((f, i) => {
  const rId = `rIdImg${i + 1}`;
  // Ancla de una celda: la foto se pega en su fila y de ahí crece.
  dibujos +=
    `<xdr:oneCellAnchor>` +
    `<xdr:from><xdr:col>${f.colNum}</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${f.fila - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${ANCHO}" cy="${ALTO}"/>` +
    `<xdr:pic>` +
    `<xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="Foto ${f.fila}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rId}"/>` +
    `<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
    `</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`;
  relsDibujo +=
    `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${f.archivo}"/>`;
});

zip.addFile(
  'xl/drawings/drawing1.xml',
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ` +
      `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${dibujos}</xdr:wsDr>`,
    'utf8'
  )
);
zip.addFile(
  'xl/drawings/_rels/drawing1.xml.rels',
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsDibujo}</Relationships>`,
    'utf8'
  )
);

// La hoja tiene que apuntar al dibujo…
const relsHojaNombre = 'xl/worksheets/_rels/sheet1.xml.rels';
let relsHoja = zip.getEntry(relsHojaNombre)
  ? leer(relsHojaNombre)
  : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
const idDibujo = 'rIdDrawing1';
relsHoja = relsHoja.replace(
  '</Relationships>',
  `<Relationship Id="${idDibujo}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`
);
zip.updateFile(relsHojaNombre, Buffer.from(relsHoja, 'utf8'));

// …y las celdas de error se vacían, para que no salga "#¡DESCONOCIDO!".
let hojaNueva = hoja.replace(
  /<c r="([A-Z]+\d+)"([^>]*?)\s*t="e"\s*vm="\d+"([^>]*)>.*?<\/c>/g,
  '<c r="$1"$2$3/>'
);
// El <drawing> va al final de la hoja, después de todo lo demás.
hojaNueva = hojaNueva.includes('<drawing ')
  ? hojaNueva
  : hojaNueva.replace('</worksheet>', `<drawing r:id="${idDibujo}"/></worksheet>`);
// Si la hoja no declaraba el espacio de nombres "r", se agrega.
if (!/xmlns:r=/.test(hojaNueva)) {
  hojaNueva = hojaNueva.replace(
    '<worksheet ',
    '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  );
}
zip.updateFile('xl/worksheets/sheet1.xml', Buffer.from(hojaNueva, 'utf8'));

// Declarar el tipo de los dibujos.
let ct = leer('[Content_Types].xml');
if (!ct.includes('drawing1.xml')) {
  ct = ct.replace(
    '</Types>',
    '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'
  );
  zip.updateFile('[Content_Types].xml', Buffer.from(ct, 'utf8'));
}

zip.writeZip(salida);
console.log('--------------------------------------------------');
console.log(`Fotos reinsertadas como imágenes normales: ${fotos.length}`);
console.log(`Archivo: ${salida} (${mb(fs.statSync(salida).size)} MB)`);
console.log('El original NO se tocó.');

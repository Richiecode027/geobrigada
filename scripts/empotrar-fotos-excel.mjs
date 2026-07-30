// Arregla Y comprime en un solo paso las fotos de un Excel armado con
// "Insertar imagen EN CELDA" (función de Excel 365; en cualquier otra versión
// y en Google Drive esas celdas salen como "#¡DESCONOCIDO!" / "#VALUE!").
//
// La foto NO queda flotando sobre varias filas — se acota EXACTAMENTE al
// rectángulo de su celda (mismo ancho de columna, mismo alto de fila que la
// foto), así que no hay forma de confundir a qué barda pertenece cada imagen:
// la fila ES la foto.
//
// Parte siempre del archivo ORIGINAL (con las imágenes en PNG sin comprimir);
// no se toca ese archivo, se escribe una copia nueva al lado.
//
// Uso:
//   node scripts/empotrar-fotos-excel.mjs "<ruta al .xlsx>" [anchoPx] [calidad]
//
// Requiere: npm i -D sharp adm-zip

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';

const archivo = process.argv[2];
if (!archivo) {
  console.error('Falta el archivo. Uso: node scripts/empotrar-fotos-excel.mjs "<ruta al .xlsx>" [anchoPx] [calidad]');
  process.exit(1);
}
const ANCHO_PX = parseInt(process.argv[3], 10) || 260; // qué tan grande se ve la foto
const CALIDAD = parseInt(process.argv[4], 10) || 78;

const salida = archivo.replace(/\.xlsx$/i, '') + ' (fotos en celda).xlsx';
const mb = (n) => (n / 1024 / 1024).toFixed(1);
const pxAPuntos = (px) => +(px * 0.75).toFixed(2); // 96 dpi -> puntos de Excel
const pxACaracteres = (px) => +(((px - 5) / 7).toFixed(2)); // ancho de columna (fuente Calibri 11)
const colANum = (c) => [...c].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

console.log(`Abriendo ${path.basename(archivo)} (${mb(fs.statSync(archivo).size)} MB)…`);
const zip = new AdmZip(archivo);
const leer = (n) => zip.readAsText(n);

// --- 1) seguir la cadena celda -> foto: vm de la celda -> metadata.xml ->
// richValue -> relación -> archivo real en xl/media -----------------------
const meta = leer('xl/metadata.xml');
const vmARich = [...meta.slice(meta.indexOf('<valueMetadata')).matchAll(/<rc t="\d+" v="(\d+)"\/>/g)].map((m) => +m[1]);
const rich = leer('xl/richData/rdrichvalue.xml');
const richARel = [...rich.matchAll(/<rv[^>]*>\s*<v>(\d+)<\/v>/g)].map((m) => +m[1]);
const relIds = [...leer('xl/richData/richValueRel.xml').matchAll(/<rel r:id="([^"]+)"\/>/g)].map((m) => m[1]);
const idAArchivo = new Map(
  [...leer('xl/richData/_rels/richValueRel.xml.rels').matchAll(/<Relationship Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(
    (m) => [m[1], path.basename(m[2])]
  )
);

const hoja = leer('xl/worksheets/sheet1.xml');
const celdas = [...hoja.matchAll(/<c r="([A-Z]+)(\d+)"[^>]*vm="(\d+)"[^>]*>/g)].map((m) => ({
  col: m[1],
  fila: +m[2],
  vm: +m[3],
  colNum: colANum(m[1])
}));

const fotos = [];
for (const c of celdas) {
  const archivoFoto = idAArchivo.get(relIds[richARel[vmARich[c.vm - 1]]]);
  if (archivoFoto) fotos.push({ ...c, archivoOriginal: archivoFoto });
}
console.log(`Fotos encontradas y ubicadas: ${fotos.length} de ${celdas.length} celdas con imagen`);
if (fotos.length === 0) {
  console.log('No se pudo seguir la pista de las fotos; el archivo no se modificó.');
  process.exit(1);
}

// La columna donde va cada foto: si una fila trae dos, la 2ª pasa a la
// siguiente columna libre (mismo criterio que ya traía el archivo).
const colsUsadas = [...new Set(fotos.map((f) => f.colNum))].sort((a, b) => a - b);
console.log(`Columnas con foto en el original: ${colsUsadas.map((c) => c + 1).join(', ')} (A=1)`);

// --- 2) comprimir cada foto y medir su relación de aspecto real -------------
console.log('Comprimiendo y midiendo cada foto…');
let pesoAntes = 0, pesoDespues = 0;
for (let i = 0; i < fotos.length; i++) {
  const f = fotos[i];
  const original = zip.getEntry('xl/media/' + f.archivoOriginal).getData();
  pesoAntes += original.length;
  const comprimida = await sharp(original)
    .rotate()
    .resize({ width: ANCHO_PX * 2, withoutEnlargement: true }) // 2x para que no se vea pixelada al hacer zoom
    .jpeg({ quality: CALIDAD, mozjpeg: true })
    .toBuffer();
  const metaImg = await sharp(comprimida).metadata();
  f.datos = comprimida;
  // Excel (y otras herramientas que leen .xlsx) solo reconocen como imagen
  // los archivos de xl/media cuyo nombre es letras/números simples — nada de
  // "_" ni paréntesis. Con guion bajo se ve bien en Excel de escritorio, pero
  // herramientas más estrictas (y quizás alguna versión) lo ignoran.
  f.archivoNuevo = 'foto' + (i + 1) + '.jpeg';
  f.relacion = metaImg.width / metaImg.height; // ancho / alto real de ESTA foto
  pesoDespues += comprimida.length;
  zip.deleteFile('xl/media/' + f.archivoOriginal); // ya no se usa el PNG grande
  zip.addFile('xl/media/' + f.archivoNuevo, comprimida);
}
console.log(`Peso de las fotos: ${mb(pesoAntes)} MB -> ${mb(pesoDespues)} MB`);

// --- 3) alto de cada fila con foto: el que le toque a SU foto ---------------
// Si una fila trae dos fotos con relación distinta, se usa la más alta de las
// dos (la otra queda con un pelín de aire arriba/abajo, no se deforma).
const altoDeFila = new Map(); // número de fila -> alto en px
for (const f of fotos) {
  const altoPx = Math.round(ANCHO_PX / f.relacion);
  altoDeFila.set(f.fila, Math.max(altoDeFila.get(f.fila) || 0, altoPx));
}

// --- 4) arma el dibujo: cada foto ACOTADA a su celda (twoCellAnchor) --------
// A diferencia de "flotar" desde una esquina, aquí se ancla de la esquina
// superior de la celda a la esquina inferior de esa MISMA celda: la imagen
// nunca puede invadir la fila de al lado.
let dibujos = '';
let relsDibujo = '';
fotos.forEach((f, i) => {
  const rId = `rIdImg${i + 1}`;
  const filaIdx = f.fila - 1; // 0-based
  dibujos +=
    `<xdr:twoCellAnchor editAs="oneCell">` +
    `<xdr:from><xdr:col>${f.colNum}</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${filaIdx}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${f.colNum + 1}</xdr:col><xdr:colOff>0</xdr:colOff>` +
    `<xdr:row>${filaIdx + 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:pic>` +
    `<xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="Barda fila ${f.fila}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
    `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rId}"/>` +
    `<a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
    `<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
    `</xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`;
  relsDibujo += `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${f.archivoNuevo}"/>`;
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

// --- 5) la hoja: apunta al dibujo, mide sus columnas/filas, vacía errores ---
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

let hojaNueva = hoja
  // Las celdas de error ("#VALUE!"/"#¡DESCONOCIDO!") se vacían: la foto de al
  // lado ya dice todo, no hace falta el texto de error debajo.
  .replace(/<c r="([A-Z]+\d+)"([^>]*?)\s*t="e"\s*vm="\d+"([^>]*)>.*?<\/c>/g, '<c r="$1"$2$3/>');

// Ancho de columna para cada columna que tiene fotos. El archivo original
// suele traer un rango "de aquí en adelante" (p. ej. min="9" max="16384") que
// JUSTO cubre las columnas de foto: si solo se agrega el <col> nuevo encima,
// queda un traslape, y según el programa que abra el archivo puede tomar el
// rango viejo o el nuevo (Excel y otras herramientas no se ponen de acuerdo).
// Por eso aquí se RECORTA cualquier rango existente que se traslape, para que
// nunca haya dos <col> hablando de la misma columna.
const anchoChars = pxACaracteres(ANCHO_PX);
const colsNuevas = colsUsadas.map((c) => ({ min: c + 1, width: anchoChars }));

function sinTraslape(hojaXml, nuevas) {
  const bloque = hojaXml.match(/<cols>([\s\S]*?)<\/cols>/);
  const existentes = bloque
    ? [...bloque[1].matchAll(/<col ([^>]*)\/>/g)].map((m) => {
        const attrs = {};
        for (const am of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[am[1]] = am[2];
        return attrs;
      })
    : [];

  const finales = [];
  for (const ex of existentes) {
    const min = +ex.min, max = +ex.max;
    const bloqueadas = nuevas.map((c) => c.min).filter((n) => n >= min && n <= max).sort((a, b) => a - b);
    let cursor = min;
    for (const b of bloqueadas) {
      if (cursor < b) finales.push({ ...ex, min: String(cursor), max: String(b - 1) });
      cursor = b + 1;
    }
    if (cursor <= max) finales.push({ ...ex, min: String(cursor), max: String(max) });
  }
  for (const c of nuevas) {
    finales.push({ min: String(c.min), max: String(c.min), width: String(c.width), customWidth: '1' });
  }
  finales.sort((a, b) => +a.min - +b.min);

  const xml =
    '<cols>' +
    finales.map((c) => '<col ' + Object.entries(c).map(([k, v]) => `${k}="${v}"`).join(' ') + '/>').join('') +
    '</cols>';
  return bloque ? hojaXml.replace(/<cols>[\s\S]*?<\/cols>/, xml) : hojaXml.replace('<sheetData>', xml + '<sheetData>');
}

hojaNueva = sinTraslape(hojaNueva, colsNuevas);

// Alto de cada fila con foto: se escribe/edita el atributo ht="" de esa fila.
for (const [fila, altoPx] of altoDeFila) {
  const alto = pxAPuntos(altoPx);
  const patronFila = new RegExp(`<row r="${fila}"([^>]*)>`);
  hojaNueva = hojaNueva.replace(patronFila, (m, attrs) => {
    let a = attrs.replace(/\s*ht="[^"]*"/, '').replace(/\s*customHeight="[^"]*"/, '');
    return `<row r="${fila}"${a} ht="${alto}" customHeight="1">`;
  });
}

if (!hojaNueva.includes('<drawing ')) {
  hojaNueva = hojaNueva.replace('</worksheet>', `<drawing r:id="${idDibujo}"/></worksheet>`);
}
if (!/xmlns:r=/.test(hojaNueva)) {
  hojaNueva = hojaNueva.replace(
    '<worksheet ',
    '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  );
}
zip.updateFile('xl/worksheets/sheet1.xml', Buffer.from(hojaNueva, 'utf8'));

// --- 6) encabezados claros: qué columna es cuál -----------------------------
// La columna "FOTO" (G) traía el LINK de Drive, no la imagen — eso es justo lo
// confuso que se quiere evitar. Se aclara con el encabezado, y las columnas de
// imagen (I, J: en la fila 1 ni siquiera tenían celda, el rango llegaba solo
// hasta H) se etiquetan.
const numAColumna = (n) => {
  let s = '';
  n++;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

// Pone (o reemplaza) el encabezado de una columna en la fila 1. Si la celda
// no existía (I1/J1 no tenían ni una etiqueta <c>), se agrega al final de la
// fila — válido porque las columnas de foto siempre van después de las que
// ya traía el archivo.
function ponerEncabezado(hojaXml, colNum, texto) {
  const ref = numAColumna(colNum) + '1';
  const nueva = `<c r="${ref}" t="inlineStr"><is><t>${texto}</t></is></c>`;
  const patronExistente = new RegExp(`<c r="${ref}"[^>]*(?:/>|>[\\s\\S]*?</c>)`);
  if (patronExistente.test(hojaXml)) {
    return hojaXml.replace(patronExistente, nueva);
  }
  return hojaXml.replace(/(<row r="1"[^>]*>)([\s\S]*?)(<\/row>)/, (m, ini, cuerpo, fin) => ini + cuerpo + nueva + fin);
}

let hojaConEncabezados = zip.readAsText('xl/worksheets/sheet1.xml');
// Aclara que "FOTO" (columna original) es el LINK, no la imagen.
hojaConEncabezados = ponerEncabezado(hojaConEncabezados, colANum('G'), 'LINK FOTO (Drive)');
if (colsUsadas[0] != null) hojaConEncabezados = ponerEncabezado(hojaConEncabezados, colsUsadas[0], 'FOTO (imagen)');
if (colsUsadas[1] != null) hojaConEncabezados = ponerEncabezado(hojaConEncabezados, colsUsadas[1], 'FOTO 2 (imagen)');

// El rango de la fila 1 (spans="1:8") debe cubrir hasta la última columna
// nueva, si no Excel podría no dibujar bien las celdas agregadas.
const colMax = Math.max(8, ...colsUsadas.map((c) => c + 1));
hojaConEncabezados = hojaConEncabezados.replace(
  /(<row r="1"[^>]*\bspans=")1:\d+(")/,
  `$11:${colMax}$2`
);

zip.updateFile('xl/worksheets/sheet1.xml', Buffer.from(hojaConEncabezados, 'utf8'));

// Declarar el tipo de los dibujos y de texto inline (por si el archivo no lo tenía).
let ct = leer('[Content_Types].xml');
if (!ct.includes('drawing1.xml')) {
  ct = ct.replace(
    '</Types>',
    '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'
  );
}
zip.updateFile('[Content_Types].xml', Buffer.from(ct, 'utf8'));

zip.writeZip(salida);
console.log('--------------------------------------------------');
console.log(`Fotos empotradas en su celda: ${fotos.length}`);
console.log(`Columnas de foto: ancho fijo (${ANCHO_PX}px); alto de cada fila según su propia foto.`);
console.log(`Archivo: ${salida} (${mb(fs.statSync(salida).size)} MB)`);
console.log('El original NO se tocó.');

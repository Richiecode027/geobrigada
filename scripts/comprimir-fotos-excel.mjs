// Achica un Excel que trae fotos pegadas (el de bardas pesa ~300 MB y no se
// puede ni mandar por correo). Las fotos van dentro del .xlsx como PNG sin
// comprimir; aquí se pasan a JPEG, que para fotografías pesa muchísimo menos
// y se ve prácticamente igual.
//
// NO toca el archivo original: escribe una copia nueva al lado.
//
// Uso:
//   node scripts/comprimir-fotos-excel.mjs "<ruta al .xlsx>" [ancho] [calidad]
//
// Requiere: npm i -D sharp adm-zip

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';

const archivo = process.argv[2];
if (!archivo) {
  console.error('Falta el archivo. Uso: node scripts/comprimir-fotos-excel.mjs "<ruta al .xlsx>" [ancho] [calidad]');
  process.exit(1);
}
// Por omisión se conserva el tamaño (no se agranda nada) y calidad alta: la
// idea es que la barda se siga viendo bien para decidir si sirve.
const ANCHO_MAX = parseInt(process.argv[3], 10) || 1600;
const CALIDAD = parseInt(process.argv[4], 10) || 80;

const salida = archivo.replace(/\.xlsx$/i, '') + ' (comprimido).xlsx';
const kb = (n) => Math.round(n / 1024);
const mb = (n) => (n / 1024 / 1024).toFixed(1);

console.log(`Abriendo ${path.basename(archivo)} (${mb(fs.statSync(archivo).size)} MB)…`);
const zip = new AdmZip(archivo);
const entradas = zip.getEntries();

const fotos = entradas.filter((e) => /^xl\/media\/.+\.(png|jpe?g)$/i.test(e.entryName));
console.log(`Fotos dentro del archivo: ${fotos.length}`);
if (fotos.length === 0) {
  console.log('No hay fotos que comprimir.');
  process.exit(0);
}

// Las fotos pasan a .jpeg, así que hay que avisarle al Excel: el nombre nuevo
// va en las relaciones (.rels) y el tipo en [Content_Types].xml. Sin esto, el
// archivo se abre roto.
const renombres = new Map(); // "image1.png" -> "image1.jpeg"
let antes = 0, despues = 0, fallidas = 0;

for (const e of fotos) {
  const original = e.getData();
  antes += original.length;
  const base = path.basename(e.entryName);
  try {
    const comprimida = await sharp(original)
      .rotate() // respeta la orientación de la cámara
      .resize({ width: ANCHO_MAX, withoutEnlargement: true })
      .jpeg({ quality: CALIDAD, mozjpeg: true })
      .toBuffer();

    // Si por lo que sea la "comprimida" pesara más, se deja la original.
    if (comprimida.length >= original.length) {
      despues += original.length;
      continue;
    }
    const nuevoNombre = base.replace(/\.(png|jpe?g)$/i, '.jpeg');
    zip.deleteFile(e.entryName);
    zip.addFile('xl/media/' + nuevoNombre, comprimida);
    renombres.set(base, nuevoNombre);
    despues += comprimida.length;
  } catch (err) {
    fallidas++;
    despues += original.length;
    console.warn(`  no se pudo comprimir ${base} (${err.message}); se deja como estaba`);
  }
  const hechas = renombres.size + fallidas;
  if (hechas % 20 === 0) process.stdout.write(`  ${hechas}/${fotos.length}\r`);
}

// --- actualiza las referencias internas -------------------------------------
if (renombres.size > 0) {
  for (const e of entradas) {
    if (!/\.(rels|xml)$/i.test(e.entryName)) continue;
    let texto;
    try {
      texto = zip.readAsText(e.entryName);
    } catch {
      continue;
    }
    let cambiado = false;
    for (const [viejo, nuevo] of renombres) {
      if (texto.includes(viejo)) {
        texto = texto.split(viejo).join(nuevo);
        cambiado = true;
      }
    }
    if (cambiado) zip.updateFile(e.entryName, Buffer.from(texto, 'utf8'));
  }

  // El tipo "jpeg" debe estar declarado para que Excel sepa leerlas.
  const ct = zip.readAsText('[Content_Types].xml');
  if (!/Extension="jpeg"/i.test(ct)) {
    const conJpeg = ct.replace(
      '<Default Extension="rels"',
      '<Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="rels"'
    );
    zip.updateFile('[Content_Types].xml', Buffer.from(conJpeg, 'utf8'));
  }
}

zip.writeZip(salida);

const tamOrig = fs.statSync(archivo).size;
const tamNuevo = fs.statSync(salida).size;
console.log('\n--------------------------------------------------');
console.log(`Fotos comprimidas: ${renombres.size}${fallidas ? ` · fallidas: ${fallidas}` : ''}`);
console.log(`Peso de las fotos: ${mb(antes)} MB -> ${mb(despues)} MB`);
console.log(`Archivo: ${mb(tamOrig)} MB -> ${mb(tamNuevo)} MB (${Math.round(100 - (100 * tamNuevo) / tamOrig)}% menos)`);
console.log(`Guardado en: ${salida}`);
console.log('El original NO se tocó.');

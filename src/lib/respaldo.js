// Respaldo descargable de todo lo que vive en la nube (oct 2026). No hay otra
// base de datos donde copiar, así que el respaldo es un archivo que se baja a
// la computadora y se guarda donde uno quiera (USB, Drive, correo...).
//
// Dos archivos separados, porque pesan muy distinto:
//   - DATOS (.json, unos cientos de KB): todas las tablas completas + el
//     catálogo de bardas del Excel. Es el que hay que bajar seguido.
//   - FOTOS (.zip, decenas de MB): todas las fotos del bucket de la nube,
//     incluso las que ya no aparecen en ninguna barda. Mejor desde una
//     computadora. Las fotos del Excel original NO van: viven en el
//     repositorio de GitHub (public/bardas-fotos), que ya es su respaldo.
//
// fflate (para el .zip) se carga solo al tocar el botón, como xlsx.

import { leerTablaCompleta, listarFotosNube, urlFotoNube } from './nube.js';

// tabla → columna por la que se ordena al leerla por páginas (su llave).
// calles_cache NO va: pesa mucho y se vuelve a armar sola desde OpenStreetMap.
const TABLAS = {
  bardas_permisos: 'barda_id',
  bardas_nuevas: 'id',
  bardas_calidad: 'barda_id',
  bardas_reservadas: 'barda_id',
  historial_cambios: 'id',
  reportes: 'id',
  rastro_nativo: 'id',
  posiciones: 'id'
};

const dos = (n) => String(n).padStart(2, '0');
function sello() {
  const d = new Date();
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}${dos(d.getMinutes())}`;
}

function bajar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Devuelve { nombre, resumen: { tabla: filas }, errores: { tabla: mensaje } }.
// Si una tabla falla se anota y se sigue con las demás: un respaldo con una
// tabla de menos sirve más que ningún respaldo.
export async function descargarRespaldoDatos() {
  const tablas = {};
  const errores = {};
  for (const [tabla, orden] of Object.entries(TABLAS)) {
    try {
      tablas[tabla] = await leerTablaCompleta(tabla, orden);
    } catch (e) {
      errores[tabla] = e.message;
    }
  }
  let catalogo = null;
  try {
    const res = await fetch(import.meta.env.BASE_URL + 'bardas.json', { cache: 'no-store' });
    if (res.ok) catalogo = await res.json();
  } catch (e) {
    errores['bardas.json'] = e.message;
  }

  const respaldo = {
    app: 'GeoBrigada',
    generado: new Date().toISOString(),
    nota:
      'Respaldo completo de la nube (Supabase). "tablas" trae cada tabla con todas sus filas; ' +
      '"catalogo_bardas" es public/bardas.json (las bardas del Excel). Las fotos van en un archivo aparte.',
    tablas,
    catalogo_bardas: catalogo,
    errores
  };
  const nombre = `Respaldo GeoBrigada datos ${sello()}.json`;
  bajar(new Blob([JSON.stringify(respaldo)], { type: 'application/json' }), nombre);
  const resumen = Object.fromEntries(Object.entries(tablas).map(([t, f]) => [t, f.length]));
  return { nombre, resumen, errores };
}

// alAvance(hechas, total) para ir enseñando el progreso.
// Devuelve { nombre, total, fallidas: [nombres] }.
export async function descargarRespaldoFotos(alAvance = () => {}) {
  const { zipSync } = await import('fflate');
  const nombres = await listarFotosNube();
  const archivos = {};
  const fallidas = [];
  let hechas = 0;
  alAvance(0, nombres.length);

  // De 4 en 4: más rápido que una por una, sin saturar la conexión.
  const cola = [...nombres];
  async function trabajador() {
    while (cola.length) {
      const nombre = cola.shift();
      try {
        const res = await fetch(urlFotoNube(nombre));
        if (!res.ok) throw new Error(String(res.status));
        archivos[nombre] = [new Uint8Array(await res.arrayBuffer()), { level: 0 }];
      } catch {
        fallidas.push(nombre);
      }
      alAvance(++hechas, nombres.length);
    }
  }
  await Promise.all([trabajador(), trabajador(), trabajador(), trabajador()]);

  // level 0 = sin comprimir: las fotos ya vienen comprimidas en JPG, volver a
  // comprimirlas solo tardaría más sin ahorrar espacio.
  const zip = zipSync(archivos);
  const nombre = `Respaldo GeoBrigada fotos ${sello()}.zip`;
  bajar(new Blob([zip], { type: 'application/zip' }), nombre);
  return { nombre, total: nombres.length, fallidas };
}

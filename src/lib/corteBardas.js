// Arma el Excel del corte: qué equipo hizo qué bardas.
//
// Sigue EXACTO el formato que ya usa la oficina para pasar las bardas
// autorizadas a pintura ("PINTA DE BARDAS MORELIA", hoja BARDAS):
//   RESPONSABLE | BRIGADA | NOMBRE | TELEFONO | DIRECCION (CALLE Y NUMERO) |
//   COLONIA | DISTRITO | REFERENCIAS | STATUS (AUTORIZADO O VISTA) |
//   COMENTARIOS | BRIGADA QUE ASISTE | FECHA DE PROGRAMACION
// Las últimas dos las llena la oficina a mano después (qué equipo va a pintar
// y cuándo) — aquí siempre salen vacías. Al final, aparte de esas columnas
// oficiales, van tres que ya teníamos y no estorban al formato: BUENA,
// COMPROMISO y REGISTRADO.
//
// La librería (xlsx) se carga solo al momento de exportar: pesa bastante y no
// tiene por qué hacer más lenta la app del brigadista, que nunca la usa.

// Las filas viejas, de antes de que existiera `estado`, solo traen el booleano.
const estadoDe = (p) =>
  p?.estado || (p?.permiso === true ? 'con_permiso' : p?.permiso === false ? 'sin_permiso' : null);

// La columna STATUS de la oficina solo distingue dos cosas: si dejaron pintar
// o no. Nuestros cuatro resultados (sin_permiso/visitado/no_habitado) caen
// los tres en "Vista": ya se fue, pero no quedó autorizada. Pendiente (nadie
// ha ido todavía) se deja en blanco: no encaja en ninguna de las dos.
const statusDe = (estado) => {
  if (estado === 'con_permiso') return 'Autorizada';
  if (estado) return 'Vista';
  return '';
};

// Las bardas agregadas desde la app nunca traen REFERENCIAS (ese campo solo
// lo trae el Excel original, con el link de Maps que resolvió quien buscó la
// barda en carro) — pero sí tienen lat/lng, porque ubicarlas con el GPS es
// obligatorio para darlas de alta. Sin este respaldo, cualquier barda
// agregada desde el teléfono salía con la columna de ubicación vacía.
function urlUbicacion(b) {
  if (b.referencia) return b.referencia;
  if (b.lat == null || b.lng == null) return '';
  return `https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lng}`;
}

// La oficina pide el corte en mayúsculas. Ojo: la columna REFERENCIAS es un
// link (p. ej. maps.app.goo.gl/EynvjocPrLTuzn5f7) y esos códigos distinguen
// mayúsculas de minúsculas — ponerlo en mayúsculas rompería el link. Por eso
// esa columna se arma aparte, sin pasar por esta función.
const mayus = (v) => String(v || '').toUpperCase();

const fechaBonita = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dosDigitos = (n) => String(n).padStart(2, '0');
  return (
    `${dosDigitos(d.getDate())}/${dosDigitos(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}`
  );
};

const ENCABEZADOS = [
  'RESPONSABLE',
  'BRIGADA',
  'NOMBRE',
  'TELEFONO',
  'DIRECCION (CALLE Y NUMERO)',
  'COLONIA',
  'DISTRITO',
  'REFERENCIAS',
  'STATUS (AUTORIZADO O VISTA)',
  'COMENTARIOS',
  'BRIGADA QUE ASISTE',
  'FECHA DE PROGRAMACION',
  'BUENA',
  'COMPROMISO ',
  'REGISTRADO'
];

// Ancho de cada columna, en caracteres (si no, sale todo apretado y hay que
// arrastrar 15 columnas a mano antes de poder leer el corte).
const ANCHOS = [16, 8, 20, 14, 34, 22, 9, 40, 22, 30, 18, 20, 7, 22, 18];

// Qué bardas entran en el corte.
export const FILTROS = [
  { id: 'todo', etiqueta: 'Todas' },
  { id: 'visitadas', etiqueta: 'Solo visitadas' },
  { id: 'con_permiso', etiqueta: 'Solo con permiso' }
];

function pasaElFiltro(estado, filtro) {
  if (filtro === 'visitadas') return Boolean(estado);
  if (filtro === 'con_permiso') return estado === 'con_permiso';
  return true;
}

// bardas   = catálogo completo (public/bardas.json + las agregadas en la app)
// permisos = filas de bardas_permisos tal como vienen de la nube
// calidad  = filas de bardas_calidad tal como vienen de la nube (opcional)
export function filasDeCorte(bardas, permisos, filtro = 'todo', calidad = []) {
  const porId = new Map();
  for (const p of permisos || []) {
    if (!p.anulado) porId.set(String(p.barda_id), p);
  }
  const buenasPorId = new Set(
    (calidad || []).filter((c) => c.buena).map((c) => String(c.barda_id))
  );

  const filas = [];
  for (const b of bardas) {
    const p = porId.get(String(b.id));
    const estado = estadoDe(p);
    if (!pasaElFiltro(estado, filtro)) continue;
    filas.push([
      mayus(p?.equipo),
      mayus(b.brigada),
      mayus(p?.nombre),
      mayus(p?.telefono),
      mayus(b.direccion),
      mayus(b.colonia),
      mayus(b.distrito),
      urlUbicacion(b), // sin mayus: es un link, distingue mayúsculas/minúsculas
      mayus(statusDe(estado)),
      mayus(p?.notas),
      '', // BRIGADA QUE ASISTE: la asigna la oficina después
      '', // FECHA DE PROGRAMACION: la agenda la oficina después
      buenasPorId.has(String(b.id)) ? 'SÍ' : '',
      mayus(p?.a_cambio),
      // Del PRIMER registro, no de la última corrección — así el corte
      // sirve para llevar control de cuándo se visitó cada barda de verdad,
      // sin que una corrección posterior mueva la fecha. Ver primer_registro
      // en scripts/esquema-supabase.sql: un trigger garantiza que nunca se
      // actualiza después de la primera vez, pase lo que pase en el cliente.
      // Respaldo a "actualizado" por si la columna primer_registro todavía
      // no existe en la base (falta correr el SQL nuevo): así el corte no se
      // queda sin fecha mientras tanto.
      mayus(fechaBonita(p?.primer_registro ?? p?.actualizado)) // no cambia (son solo números y /)
    ]);
  }
  return filas;
}

export async function descargarCorteBardas(bardas, permisos, filtro = 'todo', calidad = []) {
  const XLSX = await import('xlsx');
  const hoja = XLSX.utils.aoa_to_sheet([ENCABEZADOS, ...filasDeCorte(bardas, permisos, filtro, calidad)]);
  hoja['!cols'] = ANCHOS.map((wch) => ({ wch }));
  hoja['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: ENCABEZADOS.length - 1 } }) };
  hoja['!freeze'] = { xSplit: 0, ySplit: 1 };

  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, 'Bardas');

  const hoy = new Date();
  const dosDigitos = (n) => String(n).padStart(2, '0');
  const nombre =
    `Corte bardas ${hoy.getFullYear()}-${dosDigitos(hoy.getMonth() + 1)}-${dosDigitos(hoy.getDate())}.xlsx`;
  XLSX.writeFile(libro, nombre);
  return nombre;
}

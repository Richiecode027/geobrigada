// Arma el Excel del corte: qué equipo hizo qué bardas.
//
// Sigue el formato del reporte que ya usan en la oficina
//   NO. | BRIGADA | DIRECCION | COLONIA | DISTRITO | (vacía) | REFERENCIAS |
//   CON PERMISO | SIN PERMISO | COMPROMISO
// y le agrega al final lo que el corte necesita y ese formato no traía:
// EQUIPO, ESTADO, quién atendió, teléfono, notas y cuándo se registró.
//
// La librería (xlsx) se carga solo al momento de exportar: pesa bastante y no
// tiene por qué hacer más lenta la app del brigadista, que nunca la usa.

const ETIQUETA_ESTADO = {
  con_permiso: 'Con permiso',
  sin_permiso: 'Sin permiso',
  visitado: 'Visitado (no había nadie)',
  no_habitado: 'No habitado'
};

// Las filas viejas, de antes de que existiera `estado`, solo traen el booleano.
const estadoDe = (p) =>
  p?.estado || (p?.permiso === true ? 'con_permiso' : p?.permiso === false ? 'sin_permiso' : null);

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
  'NO.',
  'BRIGADA',
  'DIRECCION',
  'COLONIA',
  'DISTRITO',
  '',
  'REFERENCIAS',
  'CON PERMISO',
  'SIN PERMISO',
  'COMPROMISO ',
  'EQUIPO',
  'ESTADO',
  'ATENDIÓ',
  'TELÉFONO',
  'NOTAS',
  'REGISTRADO'
];

// Ancho de cada columna, en caracteres (si no, sale todo apretado y hay que
// arrastrar 16 columnas a mano antes de poder leer el corte).
const ANCHOS = [6, 8, 34, 22, 9, 3, 40, 12, 12, 22, 14, 24, 20, 14, 30, 18];

// bardas   = catálogo completo (public/bardas.json + las agregadas en la app)
// permisos = filas de bardas_permisos tal como vienen de la nube
export function filasDeCorte(bardas, permisos) {
  const porId = new Map();
  for (const p of permisos || []) {
    if (!p.anulado) porId.set(String(p.barda_id), p);
  }

  return bardas.map((b) => {
    const p = porId.get(String(b.id));
    const estado = estadoDe(p);
    return [
      b.id,
      b.brigada || '',
      b.direccion || '',
      b.colonia || '',
      b.distrito || '',
      '',
      b.referencia || '',
      estado === 'con_permiso',
      estado === 'sin_permiso',
      p?.a_cambio || '',
      p?.equipo || '',
      estado ? ETIQUETA_ESTADO[estado] || estado : 'Pendiente',
      p?.nombre || '',
      p?.telefono || '',
      p?.notas || '',
      fechaBonita(p?.actualizado)
    ];
  });
}

export async function descargarCorteBardas(bardas, permisos) {
  const XLSX = await import('xlsx');
  const hoja = XLSX.utils.aoa_to_sheet([ENCABEZADOS, ...filasDeCorte(bardas, permisos)]);
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

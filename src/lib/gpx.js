// Genera un archivo GPX (formato estándar de recorridos GPS) a partir del
// recorrido real de un reporte. Compatible con las apps de tracking que ya
// usan las brigadas: el .gpx se puede mandar por WhatsApp como antes.

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// reporte: { colonia, actividad, equipo, nEquipos, fecha, km, porcentaje,
//            entregados, notas, recorridoReal: [[lat,lng], ...] }
export function construirGPX(reporte) {
  const track = reporte.recorridoReal || [];
  const cuando = reporte.fecha || new Date().toISOString();
  const nombre =
    `${reporte.colonia || 'Colonia'} – ${reporte.actividad || 'Reparto'} – ` +
    `Equipo ${reporte.equipo}`;
  // La descripción lleva los datos del reporte dentro del propio GPX.
  const desc =
    `Actividad: ${reporte.actividad || 'Reparto'}. ` +
    `Equipo ${reporte.equipo} de ${reporte.nEquipos}. ` +
    `Objetos entregados: ${reporte.entregados ?? 0}. ` +
    `Ruta recorrida: ${reporte.porcentaje ?? 0}%.` +
    (reporte.notas ? ` Notas: ${reporte.notas}` : '');

  const puntos = track
    .map((p) => `      <trkpt lat="${p[0]}" lon="${p[1]}"></trkpt>`)
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="GeoBrigada" ` +
    `xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `  <metadata>\n` +
    `    <name>${esc(nombre)}</name>\n` +
    `    <desc>${esc(desc)}</desc>\n` +
    `    <time>${esc(cuando)}</time>\n` +
    `  </metadata>\n` +
    `  <trk>\n` +
    `    <name>${esc(nombre)}</name>\n` +
    `    <desc>${esc(desc)}</desc>\n` +
    `    <trkseg>\n` +
    puntos +
    `\n    </trkseg>\n` +
    `  </trk>\n` +
    `</gpx>\n`
  );
}

export function nombreArchivoGPX(reporte) {
  const slug = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .toLowerCase();
  const fecha = (reporte.fecha || '').slice(0, 10);
  return `geobrigada_${slug(reporte.colonia)}_${slug(reporte.actividad)}_eq${reporte.equipo}_${fecha}.gpx`;
}

// Comparte (móvil) o descarga (compu) el GPX de un reporte.
export async function compartirGPX(reporte) {
  const gpx = construirGPX(reporte);
  const nombre = nombreArchivoGPX(reporte);
  const file = new File([gpx], nombre, { type: 'application/gpx+xml' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: nombre });
      return;
    } catch {
      /* compartir cancelado: cae a la descarga */
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(a.href);
}

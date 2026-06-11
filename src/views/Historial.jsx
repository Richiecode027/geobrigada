import React, { useState } from 'react';
import { cargarReportes, borrarReporte } from '../lib/storage.js';

export default function Historial() {
  const [reportes, setReportes] = useState(cargarReportes());

  function borrar(id) {
    if (!window.confirm('¿Borrar este reporte?')) return;
    borrarReporte(id);
    setReportes(cargarReportes());
  }

  function exportar() {
    const blob = new Blob([JSON.stringify(reportes, null, 2)], {
      type: 'application/json'
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `geobrigada_reportes_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Totales de material acumulado
  const totales = {};
  let kmTotal = 0;
  for (const r of reportes) {
    kmTotal += r.km || 0;
    for (const [m, v] of Object.entries(r.materiales || {})) {
      totales[m] = (totales[m] || 0) + v;
    }
  }

  return (
    <div className="contenido">
      <div className="panel" style={{ maxHeight: 'none', flex: 1, width: '100%' }}>
        <h2>Historial de recorridos (este dispositivo)</h2>

        {reportes.length === 0 ? (
          <div className="aviso">
            Aún no hay reportes guardados. Cuando un brigadista termine su recorrido en este
            dispositivo, aparecerá aquí.
          </div>
        ) : (
          <>
            <div className="fila">
              <button className="boton suave mini" onClick={exportar}>
                ⬇️ Exportar todo (JSON)
              </button>
            </div>
            <table className="reportes">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Colonia</th>
                  <th>Equipo</th>
                  <th>Calles</th>
                  <th>Material</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {reportes.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.fecha).toLocaleDateString('es-MX')}</td>
                    <td>{r.colonia}</td>
                    <td>
                      {r.equipo}/{r.nEquipos}
                    </td>
                    <td>
                      {r.callesHechas}/{r.callesTotal}
                    </td>
                    <td>
                      {Object.entries(r.materiales || {})
                        .map(([m, v]) => `${m}: ${v}`)
                        .join(', ') || '—'}
                    </td>
                    <td>
                      <button className="boton peligro mini" onClick={() => borrar(r.id)}>
                        Borrar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Acumulado</h3>
            <p style={{ fontSize: '0.9rem' }}>
              {reportes.length} recorridos · {kmTotal.toFixed(1)} km asignados ·{' '}
              {Object.entries(totales)
                .map(([m, v]) => `${m}: ${v}`)
                .join(' · ') || 'sin material registrado'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

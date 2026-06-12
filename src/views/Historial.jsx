import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap } from '../components/useMap.js';
import { cargarReportes, borrarReporte, importarReportes } from '../lib/storage.js';
import { nubeConfigurada, cargarReportesNube, subirPendientes } from '../lib/nube.js';
import { ringsPorClave } from '../lib/colonias.js';
import { obtenerCalles } from '../api/overpass.js';
import { buildUnits } from '../lib/units.js';
import { partition, TEAM_COLORS } from '../lib/partition.js';
import { decodificarPoly } from '../lib/links.js';
import { ringsBounds, partirTrayectoria } from '../lib/geo.js';

export default function Historial() {
  const mapaRef = useRef(null);
  const map = useMap(mapaRef);
  const capa = useRef(null);
  const fileRef = useRef(null);

  const [reportes, setReportes] = useState(cargarReportes());
  const [nube, setNube] = useState([]);
  const [cargandoNube, setCargandoNube] = useState(false);
  const [seleccion, setSeleccion] = useState(null); // reportes a dibujar en el mapa
  const [aviso, setAviso] = useState('');

  // Al abrir: sube lo que haya quedado pendiente y baja lo de la nube.
  useEffect(() => {
    if (!nubeConfigurada()) return;
    subirPendientes().then(() => refrescarNube());
  }, []);

  async function refrescarNube() {
    setCargandoNube(true);
    try {
      setNube(await cargarReportesNube());
    } catch (e) {
      setAviso('No se pudo leer la nube (' + e.message + '). Revisa tu internet.');
    }
    setCargandoNube(false);
  }

  // Combina nube + locales sin duplicar (mismo fecha+equipo+colonia).
  const firma = (r) => `${r.fecha}|${r.equipo}|${r.colonia}`;
  const enNube = new Set(nube.map(firma));
  const todos = [...nube, ...reportes.filter((r) => !enNube.has(firma(r)))].sort(
    (a, b) => new Date(b.fecha) - new Date(a.fecha)
  );

  function borrar(id) {
    if (!window.confirm('¿Borrar este reporte?')) return;
    borrarReporte(id);
    setReportes(cargarReportes());
    setSeleccion(null);
  }

  function exportar() {
    const blob = new Blob([JSON.stringify(todos, null, 2)], {
      type: 'application/json'
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `geobrigada_reportes_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Importa los archivos .json que los brigadistas comparten al terminar.
  async function importar(e) {
    const files = [...e.target.files];
    const nuevos = [];
    for (const f of files) {
      try {
        const data = JSON.parse(await f.text());
        if (Array.isArray(data)) nuevos.push(...data);
        else nuevos.push(data);
      } catch {
        /* archivo que no es un reporte: se ignora */
      }
    }
    const n = importarReportes(nuevos);
    setReportes(cargarReportes());
    setAviso(
      n > 0
        ? `✅ Se importaron ${n} recorrido(s). Usa "Ver" o "Ver todas" para revisarlos en el mapa.`
        : 'Esos archivos no traen recorridos nuevos (quizá ya estaban importados).'
    );
    e.target.value = '';
  }

  // --- dibujo en el mapa ----------------------------------------------------
  useEffect(() => {
    if (!map) return;
    if (capa.current) capa.current.remove();
    if (!seleccion || seleccion.length === 0) return;
    const g = L.layerGroup().addTo(map);
    capa.current = g;

    (async () => {
      const bounds = [];

      // Al ver UN solo equipo se dibuja también su ruta asignada (tenue),
      // para comparar lo planeado contra lo caminado.
      if (seleccion.length === 1) {
        const r = seleccion[0];
        try {
          let rings = null;
          if (r.col) rings = await ringsPorClave(r.col);
          else if (r.poly) rings = [decodificarPoly(r.poly)];
          if (rings && r.nEquipos) {
            const ways = await obtenerCalles(rings);
            const units = buildUnits(ways, rings);
            const grupos = partition(units, r.nEquipos);
            const mia = grupos[r.equipo - 1] || [];
            const color = TEAM_COLORS[(r.equipo - 1) % TEAM_COLORS.length];
            mia.forEach((u) => {
              L.polyline(u.coords, { color, weight: 5, opacity: 0.25 }).addTo(g);
              bounds.push(...u.coords);
            });
          }
        } catch {
          /* sin internet o reporte viejo: se muestra solo la trayectoria */
        }
      }

      for (const r of seleccion) {
        const t = r.recorridoReal || [];
        if (t.length < 2) continue;
        const color = TEAM_COLORS[((r.equipo || 1) - 1) % TEAM_COLORS.length];
        // Trazo partido donde hubo huecos de GPS (teléfono bloqueado): el
        // hueco se une con puntitos, no con una línea recta falsa.
        const segs = partirTrayectoria(t);
        segs.forEach((s, i) => {
          L.polyline(s, { color, weight: 4, opacity: 0.9 }).addTo(g);
          if (i > 0) {
            const fin = segs[i - 1][segs[i - 1].length - 1];
            L.polyline([fin, s[0]], {
              color, weight: 2, opacity: 0.5, dashArray: '2 8'
            }).addTo(g);
          }
        });
        // inicio (relleno) y fin (anillo) de la caminata
        L.circleMarker(t[0], {
          radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1
        }).addTo(g);
        L.circleMarker(t[t.length - 1], {
          radius: 7, color, weight: 3, fillColor: '#fff', fillOpacity: 1
        }).addTo(g);
        bounds.push(...t);
      }

      if (bounds.length) {
        map.fitBounds(ringsBounds([bounds]), { padding: [25, 25] });
      }
    })();
  }, [map, seleccion]);

  const conTrayectoria = todos.filter(
    (r) => (r.recorridoReal || []).length > 1
  );

  // Totales acumulados (compatible con reportes viejos que usaban "materiales").
  let kmTotal = 0;
  let entregadoTotal = 0;
  for (const r of todos) {
    kmTotal += r.km || 0;
    if (r.entregados != null) entregadoTotal += r.entregados;
    else if (r.materiales) {
      entregadoTotal += Object.values(r.materiales).reduce((s, v) => s + v, 0);
    }
  }

  return (
    <div className="contenido">
      <div className="mapa" ref={mapaRef} />
      <div className="panel">
        <h2>Historial de recorridos</h2>

        <div className="fila">
          {nubeConfigurada() && (
            <button
              className="boton primario mini"
              onClick={refrescarNube}
              disabled={cargandoNube}
            >
              {cargandoNube ? '☁️ Cargando…' : '🔄 Actualizar'}
            </button>
          )}
          <button className="boton suave mini" onClick={() => fileRef.current.click()}>
            📥 Importar
          </button>
          <button
            className="boton suave mini"
            onClick={() => setSeleccion(conTrayectoria)}
            disabled={conTrayectoria.length === 0}
          >
            🗺️ Ver todas las trayectorias
          </button>
          {todos.length > 0 && (
            <button className="boton suave mini" onClick={exportar}>
              ⬇️ Exportar todo
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            multiple
            style={{ display: 'none' }}
            onChange={importar}
          />
        </div>

        {aviso && <div className="aviso">{aviso}</div>}

        {todos.length === 0 ? (
          <div className="aviso">
            Aún no hay reportes. Cuando un brigadista termine su recorrido aparecerá
            aquí{nubeConfigurada() ? ' automáticamente' : ''}; también puedes{' '}
            <strong>importar</strong> archivos que te manden por WhatsApp.
          </div>
        ) : (
          <>
            <table className="reportes">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Colonia</th>
                  <th>Eq.</th>
                  <th>Ruta</th>
                  <th>Entregado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {todos.map((r) => (
                  <tr key={r.id}>
                    <td>{new Date(r.fecha).toLocaleDateString('es-MX')}</td>
                    <td>
                      {r.colonia}
                      <div style={{ fontSize: '0.75rem', color: '#888' }}>
                        {r.actividad || 'Reparto'}
                      </div>
                    </td>
                    <td>
                      {r.equipo}/{r.nEquipos}
                    </td>
                    <td>
                      {r.porcentaje != null
                        ? r.porcentaje + '%'
                        : `${r.callesHechas ?? '—'}/${r.callesTotal ?? '—'}`}
                    </td>
                    <td>
                      {r.entregados != null
                        ? r.entregados
                        : Object.entries(r.materiales || {})
                            .map(([m, v]) => `${m}: ${v}`)
                            .join(', ') || '—'}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        className="boton suave mini"
                        onClick={() => setSeleccion([r])}
                        disabled={(r.recorridoReal || []).length < 2}
                        title="Ver trayectoria en el mapa"
                      >
                        Ver
                      </button>{' '}
                      {!r.delaNube && (
                        <button className="boton peligro mini" onClick={() => borrar(r.id)}>
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Acumulado</h3>
            <p style={{ fontSize: '0.9rem' }}>
              {todos.length} recorridos · {kmTotal.toFixed(1)} km asignados ·{' '}
              {entregadoTotal} objetos entregados
            </p>
            {seleccion && seleccion.length === 1 && (
              <div className="aviso">
                En el mapa: la línea tenue es la ruta que se le asignó al equipo; la
                línea fuerte es por donde caminó de verdad (● inicio, ○ fin). Lo tenue
                sin línea fuerte encima es lo que faltó por visitar.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

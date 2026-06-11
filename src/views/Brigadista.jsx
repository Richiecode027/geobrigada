import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap, marcadorInicio, marcadorEncuentro } from '../components/useMap.js';
import { ringsPorClave } from '../lib/colonias.js';
import { obtenerCalles } from '../api/overpass.js';
import { buildUnits } from '../lib/units.js';
import { partition, orderRoute, puntoDeEncuentro, TEAM_COLORS } from '../lib/partition.js';
import { ringsBounds, haversine } from '../lib/geo.js';
import { decodificarPoly } from '../lib/links.js';
import {
  guardarReporte,
  cargarProgreso,
  guardarProgreso,
  limpiarProgreso
} from '../lib/storage.js';

const MATERIALES = ['Folletos', 'Calendarios', 'Lonas', 'Flores', 'Otros'];

function hashSimple(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Agrupa tramos consecutivos de la ruta por nombre de calle para la lista.
function agruparCalles(ruta) {
  const grupos = [];
  for (const u of ruta) {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.nombre === u.name) {
      ultimo.metros += u.length;
    } else {
      grupos.push({ nombre: u.name, metros: u.length });
    }
  }
  return grupos;
}

export default function Brigadista({ params }) {
  const mapaRef = useRef(null);
  const map = useMap(mapaRef);
  const capaRuta = useRef(null);
  const capaGps = useRef(null);
  const capaTrack = useRef(null);
  const watchId = useRef(null);
  const track = useRef([]);

  const claveRuta = `${params.col || 'poly' + hashSimple(params.poly || '')}_${params.nEquipos}_${params.equipo}`;

  const [fase, setFase] = useState('cargando'); // cargando | listo | formulario | terminado | error
  const [error, setError] = useState('');
  const [miRuta, setMiRuta] = useState(null);
  const [otras, setOtras] = useState([]);
  const [encuentro, setEncuentro] = useState(null);
  const [calles, setCalles] = useState([]);
  const [hechas, setHechas] = useState({});
  const [gpsActivo, setGpsActivo] = useState(false);
  const [gpsError, setGpsError] = useState('');
  const [materiales, setMateriales] = useState(
    Object.fromEntries(MATERIALES.map((m) => [m, '']))
  );
  const [notas, setNotas] = useState('');
  const [resumen, setResumen] = useState('');

  const color = TEAM_COLORS[(params.equipo - 1) % TEAM_COLORS.length];

  // --- carga inicial: recalcula la misma división que vio el coordinador ---
  useEffect(() => {
    (async () => {
      try {
        let rings;
        if (params.col) {
          rings = await ringsPorClave(params.col);
          if (!rings) throw new Error('No se encontró la colonia con clave ' + params.col);
        } else if (params.poly) {
          rings = [decodificarPoly(params.poly)];
        } else {
          throw new Error('El link no incluye la colonia.');
        }
        const ways = await obtenerCalles(rings);
        const units = buildUnits(ways, rings);
        if (units.length === 0) throw new Error('No hay calles dentro del área.');
        const inicio = puntoDeEncuentro(units);
        const grupos = partition(units, params.nEquipos);
        if (params.equipo < 1 || params.equipo > grupos.length) {
          throw new Error('Número de equipo inválido para esta colonia.');
        }
        const rutas = grupos.map((g) => orderRoute(g, inicio));
        const mia = rutas[params.equipo - 1];
        setEncuentro(inicio);
        setMiRuta(mia);
        setOtras(rutas.filter((_, i) => i !== params.equipo - 1));
        setCalles(agruparCalles(mia));
        setHechas(cargarProgreso(claveRuta));
        setFase('listo');
      } catch (err) {
        setError(err.message);
        setFase('error');
      }
    })();
    return () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    };
  }, []);

  // --- dibujar ruta -----------------------------------------------------
  useEffect(() => {
    if (!map || !miRuta) return;
    if (capaRuta.current) capaRuta.current.remove();
    const g = L.layerGroup().addTo(map);
    // Rutas de los otros equipos, tenues, para referencia.
    otras.forEach((r) =>
      r.forEach((u) =>
        L.polyline(u.coords, { color: '#999', weight: 2, opacity: 0.4 }).addTo(g)
      )
    );
    miRuta.forEach((u) =>
      L.polyline(u.coords, { color, weight: 5, opacity: 0.9 }).addTo(g)
    );
    marcadorInicio(miRuta[0].coords[0], params.equipo, color).addTo(g);
    if (encuentro) marcadorEncuentro(encuentro).addTo(g);
    capaRuta.current = g;
    const todos = miRuta.flatMap((u) => u.coords);
    map.fitBounds(ringsBounds([todos]), { padding: [20, 20] });
  }, [map, miRuta]);

  // --- GPS ----------------------------------------------------------------
  function activarGPS() {
    if (!('geolocation' in navigator)) {
      setGpsError('Este navegador no tiene GPS disponible.');
      return;
    }
    setGpsError('');
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const p = [pos.coords.latitude, pos.coords.longitude];
        setGpsActivo(true);
        // guarda el recorrido real (un punto cada ~15 m)
        const ultimo = track.current[track.current.length - 1];
        if (!ultimo || haversine(ultimo, p) > 15) track.current.push(p);
        if (!map) return;
        if (capaGps.current) capaGps.current.remove();
        const g = L.layerGroup().addTo(map);
        L.circle(p, { radius: pos.coords.accuracy, color: '#1d6fd1', weight: 1, fillOpacity: 0.1 }).addTo(g);
        L.circleMarker(p, { radius: 8, color: '#fff', weight: 2, fillColor: '#1d6fd1', fillOpacity: 1 }).addTo(g);
        capaGps.current = g;
        if (capaTrack.current) capaTrack.current.remove();
        if (track.current.length > 1) {
          capaTrack.current = L.polyline(track.current, {
            color: '#222',
            weight: 2,
            dashArray: '4 5'
          }).addTo(map);
        }
      },
      (err) => {
        setGpsError(
          'No se pudo obtener tu ubicación. Revisa permisos de ubicación del navegador. (' +
            err.message +
            ')'
        );
        setGpsActivo(false);
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
  }

  function centrarEnMi() {
    const ultimo = track.current[track.current.length - 1];
    if (ultimo && map) map.setView(ultimo, 17);
  }

  // --- progreso y cierre ---------------------------------------------------
  function marcarCalle(i) {
    const nuevo = { ...hechas, [i]: !hechas[i] };
    setHechas(nuevo);
    guardarProgreso(claveRuta, nuevo);
  }

  const totalKm = miRuta ? miRuta.reduce((s, u) => s + u.length, 0) / 1000 : 0;
  const nHechas = calles.filter((_, i) => hechas[i]).length;

  function terminarRecorrido() {
    const mat = {};
    for (const m of MATERIALES) {
      const v = parseInt(materiales[m], 10);
      if (v > 0) mat[m] = v;
    }
    const reporte = {
      fecha: new Date().toISOString(),
      colonia: params.nombre,
      equipo: params.equipo,
      nEquipos: params.nEquipos,
      km: Math.round(totalKm * 10) / 10,
      callesTotal: calles.length,
      callesHechas: nHechas,
      materiales: mat,
      notas: notas.trim(),
      recorridoReal: track.current
    };
    guardarReporte(reporte);
    limpiarProgreso(claveRuta);

    const lineasMat = Object.entries(mat).map(([k, v]) => `• ${k}: ${v}`);
    const texto =
      `🗺️ GeoBrigada – Reporte de recorrido\n` +
      `Colonia: ${params.nombre}\n` +
      `Equipo: ${params.equipo} de ${params.nEquipos}\n` +
      `Fecha: ${new Date().toLocaleString('es-MX')}\n` +
      `Calles cubiertas: ${nHechas}/${calles.length} (${totalKm.toFixed(1)} km asignados)\n` +
      `Material repartido:\n${lineasMat.length ? lineasMat.join('\n') : '• (sin registrar)'}` +
      (notas.trim() ? `\nNotas: ${notas.trim()}` : '');
    setResumen(texto);
    setFase('terminado');
  }

  async function copiarResumen() {
    try {
      await navigator.clipboard.writeText(resumen);
    } catch {
      window.prompt('Copia el resumen:', resumen);
    }
  }

  // --- render ---------------------------------------------------------------
  return (
    <div className="app">
      <header className="encabezado">
        <h1>🗺️ {params.nombre}</h1>
        <span className="sub">
          Equipo {params.equipo} de {params.nEquipos}
        </span>
      </header>
      <div className="contenido">
        <div className="mapa" ref={mapaRef} />
        <div className="panel">
          {fase === 'cargando' && <p>Cargando tu ruta…</p>}
          {fase === 'error' && <div className="error">{error}</div>}

          {(fase === 'listo' || fase === 'formulario') && miRuta && (
            <>
              <div className="fila">
                <button
                  className={gpsActivo ? 'boton exito' : 'boton primario'}
                  onClick={gpsActivo ? centrarEnMi : activarGPS}
                >
                  {gpsActivo ? '📍 Centrar en mí' : '📡 Activar mi GPS'}
                </button>
                <span style={{ fontSize: '0.85rem', color: '#555' }}>
                  {totalKm.toFixed(1)} km · {calles.length} calles
                </span>
              </div>
              {gpsError && <div className="error">{gpsError}</div>}

              <h3>
                Tu lista de calles ({nHechas}/{calles.length})
              </h3>
              <div className="progreso-barra">
                <div style={{ width: (calles.length ? (nHechas / calles.length) * 100 : 0) + '%' }} />
              </div>
              <ul className="lista-calles">
                {calles.map((c, i) => (
                  <li key={i}>
                    <input
                      type="checkbox"
                      checked={!!hechas[i]}
                      onChange={() => marcarCalle(i)}
                    />
                    <span className={hechas[i] ? 'hecha' : ''}>
                      {i + 1}. {c.nombre}
                    </span>
                    <span className="km">{(c.metros / 1000).toFixed(2)} km</span>
                  </li>
                ))}
              </ul>

              {fase === 'listo' && (
                <div className="fila" style={{ marginTop: 12 }}>
                  <button className="boton primario" onClick={() => setFase('formulario')}>
                    ✓ Terminé mi recorrido
                  </button>
                </div>
              )}

              {fase === 'formulario' && (
                <>
                  <h3>¿Cuánto material repartiste?</h3>
                  <div className="form-material">
                    {MATERIALES.map((m) => (
                      <React.Fragment key={m}>
                        <label>{m}</label>
                        <input
                          type="number"
                          min="0"
                          placeholder="0"
                          value={materiales[m]}
                          onChange={(e) =>
                            setMateriales({ ...materiales, [m]: e.target.value })
                          }
                        />
                      </React.Fragment>
                    ))}
                  </div>
                  <h3>Notas (opcional)</h3>
                  <textarea
                    rows="2"
                    value={notas}
                    placeholder="Ej. La calle X estaba cerrada"
                    onChange={(e) => setNotas(e.target.value)}
                  />
                  <div className="fila" style={{ marginTop: 10 }}>
                    <button className="boton exito" onClick={terminarRecorrido}>
                      Guardar reporte
                    </button>
                    <button className="boton suave" onClick={() => setFase('listo')}>
                      Volver
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {fase === 'terminado' && (
            <>
              <h2>✅ ¡Recorrido registrado!</h2>
              <div className="resumen-final">{resumen}</div>
              <div className="fila" style={{ marginTop: 10 }}>
                <button className="boton suave" onClick={copiarResumen}>
                  Copiar resumen
                </button>
                <button
                  className="boton exito"
                  onClick={() =>
                    window.open('https://wa.me/?text=' + encodeURIComponent(resumen), '_blank')
                  }
                >
                  Enviar por WhatsApp
                </button>
              </div>
              <div className="aviso" style={{ marginTop: 10 }}>
                Envía el resumen a tu coordinador por WhatsApp. El reporte también quedó
                guardado en este teléfono (pestaña Historial).
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap, marcadorInicio, marcadorEncuentro } from '../components/useMap.js';
import { ringsPorClave } from '../lib/colonias.js';
import { obtenerCalles } from '../api/overpass.js';
import { buildUnits } from '../lib/units.js';
import { partition, orderRoute, puntoDeEncuentro, TEAM_COLORS } from '../lib/partition.js';
import { ringsBounds, haversine, partirTrayectoria } from '../lib/geo.js';
import { decodificarPoly } from '../lib/links.js';
import {
  guardarReporte,
  cargarProgreso,
  guardarProgreso,
  limpiarProgreso
} from '../lib/storage.js';
import {
  nubeConfigurada,
  subirReporte,
  encolarPendiente,
  subirPendientes,
  subirPosicion
} from '../lib/nube.js';

// Un punto de la ruta cuenta como recorrido si el GPS pasó a menos de esto.
const RADIO_CUBIERTO_M = 30;

function hashSimple(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Agrupa tramos consecutivos de la ruta por nombre de calle para la lista.
// Guarda los índices de los tramos para calcular el avance por calle.
function agruparCalles(ruta) {
  const grupos = [];
  ruta.forEach((u, i) => {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.nombre === u.name) {
      ultimo.metros += u.length;
      ultimo.idx.push(i);
    } else {
      grupos.push({ nombre: u.name, metros: u.length, idx: [i] });
    }
  });
  return grupos;
}

// % de la ruta cubierto: metros con GPS encima / metros totales.
function calcularPct(ruta, cubierto) {
  let total = 0;
  let hecho = 0;
  ruta.forEach((u, i) => {
    total += u.length;
    const c = cubierto[i];
    hecho += (u.length * c.reduce((s, v) => s + v, 0)) / c.length;
  });
  return total ? Math.round((100 * hecho) / total) : 0;
}

export default function Brigadista({ params }) {
  const mapaRef = useRef(null);
  const map = useMap(mapaRef);
  const capaRuta = useRef(null);
  const capaGps = useRef(null);
  const capaTrack = useRef(null);
  const watchId = useRef(null);
  const track = useRef([]);
  const wakeLock = useRef(null);
  const ultimaPosSubida = useRef(0);
  const rutaRef = useRef(null);
  // cubierto[i][j] = 1 si el GPS ya pasó cerca del punto j del tramo i.
  const cubierto = useRef([]);

  const claveRuta = `${params.col || 'poly' + hashSimple(params.poly || '')}_${params.nEquipos}_${params.equipo}`;

  const [fase, setFase] = useState('cargando'); // cargando | listo | formulario | terminado | error
  const [error, setError] = useState('');
  const [miRuta, setMiRuta] = useState(null);
  const [otras, setOtras] = useState([]);
  const [encuentro, setEncuentro] = useState(null);
  const [calles, setCalles] = useState([]);
  const [pct, setPct] = useState(0);
  const [gpsActivo, setGpsActivo] = useState(false);
  const [gpsError, setGpsError] = useState('');
  const [entregados, setEntregados] = useState('');
  const [notas, setNotas] = useState('');
  const [resumen, setResumen] = useState('');
  const [reporteFinal, setReporteFinal] = useState(null);
  // '' | 'subiendo' | 'ok' | 'pendiente' — estado del envío a la nube
  const [estadoNube, setEstadoNube] = useState('');

  const color = TEAM_COLORS[(params.equipo - 1) % TEAM_COLORS.length];

  // --- carga inicial: recalcula la misma división que vio el coordinador ---
  useEffect(() => {
    // Si quedó algún reporte sin subir (terminó sin señal), se reintenta ahora.
    subirPendientes();
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
        rutaRef.current = mia;

        // Restaura el avance guardado (sobrevive si se recarga la página).
        const prog = cargarProgreso(claveRuta);
        if (Array.isArray(prog.track)) track.current = prog.track;
        cubierto.current = mia.map((u, ui) => {
          const c = Array.isArray(prog.cubierto) ? prog.cubierto[ui] : null;
          return Array.isArray(c) && c.length === u.coords.length
            ? c
            : new Array(u.coords.length).fill(0);
        });

        setEncuentro(inicio);
        setMiRuta(mia);
        setOtras(rutas.filter((_, i) => i !== params.equipo - 1));
        setCalles(agruparCalles(mia));
        setPct(calcularPct(mia, cubierto.current));
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
        L.polyline(u.coords, { color: '#999', weight: 2, opacity: 0.35 }).addTo(g)
      )
    );
    // Semitransparente para que el nombre de la calle se lea debajo.
    miRuta.forEach((u) =>
      L.polyline(u.coords, { color, weight: 6, opacity: 0.5 }).addTo(g)
    );
    marcadorInicio(miRuta[0].coords[0], params.equipo, color).addTo(g);
    if (encuentro) marcadorEncuentro(encuentro).addTo(g);
    capaRuta.current = g;
    // Recorrido previo restaurado (si recargó la página a media caminata).
    dibujarTrack();
    const todos = miRuta.flatMap((u) => u.coords);
    map.fitBounds(ringsBounds([todos]), { padding: [20, 20] });
  }, [map, miRuta]);

  // Dibuja el rastro real partido en segmentos: donde hubo un hueco grande
  // (teléfono bloqueado) no se pinta línea recta falsa.
  function dibujarTrack() {
    if (!map) return;
    if (capaTrack.current) capaTrack.current.remove();
    const segs = partirTrayectoria(track.current);
    if (segs.length === 0) return;
    const g = L.layerGroup().addTo(map);
    segs.forEach((s) =>
      L.polyline(s, { color: '#222', weight: 2, dashArray: '4 5' }).addTo(g)
    );
    capaTrack.current = g;
  }

  // Mientras el GPS está activo, se le pide al teléfono no apagar la pantalla:
  // con la pantalla bloqueada el navegador congela la página y se pierde el rastro.
  useEffect(() => {
    if (!gpsActivo) return;
    async function pedirPantallaActiva() {
      try {
        if ('wakeLock' in navigator) {
          wakeLock.current = await navigator.wakeLock.request('screen');
        }
      } catch {
        /* batería baja o navegador sin soporte: la app sigue normal */
      }
    }
    pedirPantallaActiva();
    // Si el usuario bloqueó de todos modos, al volver se vuelve a pedir.
    const alVolver = () => {
      if (document.visibilityState === 'visible') pedirPantallaActiva();
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => {
      document.removeEventListener('visibilitychange', alVolver);
      if (wakeLock.current) {
        wakeLock.current.release().catch(() => {});
        wakeLock.current = null;
      }
    };
  }, [gpsActivo]);

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
        const seMovio = !ultimo || haversine(ultimo, p) > 15;
        if (seMovio) track.current.push(p);

        // marca como recorridos los puntos de la ruta cercanos al GPS
        let cambio = false;
        if (rutaRef.current) {
          rutaRef.current.forEach((u, ui) => {
            const c = cubierto.current[ui];
            for (let j = 0; j < u.coords.length; j++) {
              if (!c[j] && haversine(p, u.coords[j]) < RADIO_CUBIERTO_M) {
                c[j] = 1;
                cambio = true;
              }
            }
          });
        }
        if (cambio) setPct(calcularPct(rutaRef.current, cubierto.current));
        if (cambio || seMovio) {
          guardarProgreso(claveRuta, {
            track: track.current,
            cubierto: cubierto.current
          });
        }

        // Reporta la posición al coordinador cada ~25 s (pesa ~2 KB).
        if (Date.now() - ultimaPosSubida.current > 25000) {
          ultimaPosSubida.current = Date.now();
          subirPosicion({
            id: claveRuta,
            colonia: params.nombre,
            col: params.col || null,
            equipo: params.equipo,
            n_equipos: params.nEquipos,
            lat: p[0],
            lng: p[1],
            pct: rutaRef.current ? calcularPct(rutaRef.current, cubierto.current) : 0
          });
        }

        if (!map) return;
        if (capaGps.current) capaGps.current.remove();
        const g = L.layerGroup().addTo(map);
        L.circle(p, { radius: pos.coords.accuracy, color: '#1d6fd1', weight: 1, fillOpacity: 0.1 }).addTo(g);
        L.circleMarker(p, { radius: 8, color: '#fff', weight: 2, fillColor: '#1d6fd1', fillOpacity: 1 }).addTo(g);
        capaGps.current = g;
        if (seMovio) dibujarTrack();
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

  // --- avance por calle (automático, según el GPS) -------------------------
  function pctCalle(grupo) {
    if (!rutaRef.current || !grupo.metros) return 0;
    let m = 0;
    for (const ui of grupo.idx) {
      const u = rutaRef.current[ui];
      const c = cubierto.current[ui];
      m += (u.length * c.reduce((s, v) => s + v, 0)) / c.length;
    }
    return (100 * m) / grupo.metros;
  }

  const totalKm = miRuta ? miRuta.reduce((s, u) => s + u.length, 0) / 1000 : 0;

  // --- cierre ---------------------------------------------------------------
  function terminarRecorrido() {
    // Se apaga el GPS y se libera la pantalla: el recorrido ya terminó.
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    setGpsActivo(false);

    const n = parseInt(entregados, 10) || 0;
    const reporte = {
      fecha: new Date().toISOString(),
      colonia: params.nombre,
      col: params.col || null,
      poly: params.poly || null,
      equipo: params.equipo,
      nEquipos: params.nEquipos,
      km: Math.round(totalKm * 10) / 10,
      porcentaje: pct,
      entregados: n,
      notas: notas.trim(),
      recorridoReal: track.current.map((q) => [+q[0].toFixed(5), +q[1].toFixed(5)])
    };
    guardarReporte(reporte);
    limpiarProgreso(claveRuta);

    // Sube el reporte a la nube; sin señal, queda en cola y se reintenta solo.
    if (nubeConfigurada()) {
      setEstadoNube('subiendo');
      subirReporte(reporte).then((ok) => {
        if (ok) {
          setEstadoNube('ok');
        } else {
          encolarPendiente(reporte);
          setEstadoNube('pendiente');
        }
      });
    }

    const texto =
      `🗺️ GeoBrigada – Reporte de recorrido\n` +
      `Colonia: ${params.nombre}\n` +
      `Equipo: ${params.equipo} de ${params.nEquipos}\n` +
      `Fecha: ${new Date().toLocaleString('es-MX')}\n` +
      `Ruta recorrida: ${pct}% (${totalKm.toFixed(1)} km asignados)\n` +
      `Objetos entregados: ${n}` +
      (notas.trim() ? `\nNotas: ${notas.trim()}` : '');
    setResumen(texto);
    setReporteFinal(reporte);
    setFase('terminado');
  }

  async function copiarResumen() {
    try {
      await navigator.clipboard.writeText(resumen);
    } catch {
      window.prompt('Copia el resumen:', resumen);
    }
  }

  // Comparte el recorrido como archivo: el coordinador lo importa en la
  // pestaña Historial y ve la trayectoria de cada equipo en el mapa.
  async function compartirArchivo() {
    const json = JSON.stringify(reporteFinal);
    const nombre = `geobrigada_eq${params.equipo}_${(params.nombre || 'colonia')
      .replace(/\s+/g, '_')
      .toLowerCase()}.json`;
    const file = new File([json], nombre, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Recorrido GeoBrigada' });
        return;
      } catch {
        /* compartir cancelado: cae a la descarga */
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(a.href);
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
          {fase === 'cargando' && (
            <>
              <p>Cargando tu ruta…</p>
              <p className="nota">
                La primera vez se descargan las calles de tu colonia; puede tardar
                hasta un minuto. Después queda guardado en tu teléfono.
              </p>
            </>
          )}
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
              {gpsActivo && (
                <p className="nota">
                  🔆 La pantalla se mantendrá encendida mientras recorres, para no
                  perder tu rastro. <strong>No bloquees el teléfono</strong>: si lo
                  bloqueas, el GPS se pausa hasta que lo desbloquees.
                </p>
              )}

              <h3>Porcentaje de la ruta recorrido</h3>
              <div className="fila" style={{ alignItems: 'center' }}>
                <span className="pct-grande" style={{ color }}>
                  {pct}%
                </span>
                <div className="progreso-barra" style={{ flex: 1, margin: 0 }}>
                  <div style={{ width: pct + '%' }} />
                </div>
              </div>
              <p className="nota">
                Se calcula solo con tu GPS: camina las calles de tu color y el
                porcentaje sube automáticamente.
              </p>

              <h3>Tus calles</h3>
              <ul className="lista-calles">
                {calles.map((c, i) => {
                  const pc = pctCalle(c);
                  return (
                    <li key={i}>
                      <span className={pc >= 70 ? 'hecha' : ''}>
                        {i + 1}. {c.nombre}
                      </span>
                      <span className="km">
                        {(c.metros / 1000).toFixed(2)} km ·{' '}
                        {pc >= 70 ? '✓' : Math.round(pc) + '%'}
                      </span>
                    </li>
                  );
                })}
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
                  <h3>¿Cuántos objetos entregaste?</h3>
                  <div className="fila">
                    <input
                      type="number"
                      min="0"
                      placeholder="0"
                      value={entregados}
                      onChange={(e) => setEntregados(e.target.value)}
                    />
                    <span style={{ fontSize: '0.85rem', color: '#555' }}>
                      objetos entregados
                    </span>
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

              {estadoNube === 'subiendo' && (
                <div className="aviso">☁️ Enviando tu recorrido al coordinador…</div>
              )}
              {estadoNube === 'ok' && (
                <div className="aviso" style={{ background: '#f0f6ee', borderColor: '#cde3c8' }}>
                  ☁️ ¡Listo! Tu recorrido y tu reporte ya le llegaron al coordinador
                  automáticamente. No tienes que hacer nada más.
                </div>
              )}
              {estadoNube === 'pendiente' && (
                <div className="aviso">
                  📶 Ahora mismo no hay señal: tu recorrido se enviará solo en cuanto
                  el teléfono recupere internet (puedes cerrar la página; al volver a
                  abrir tu link se envía).
                </div>
              )}

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
              {estadoNube !== 'ok' && estadoNube !== 'subiendo' && (
                <>
                  <div className="fila">
                    <button className="boton primario" onClick={compartirArchivo}>
                      📤 Enviar mi trayectoria al coordinador
                    </button>
                  </div>
                  <div className="aviso" style={{ marginTop: 10 }}>
                    El botón azul comparte un archivo con tu recorrido GPS. Mándaselo al
                    coordinador (por WhatsApp): él lo importa en la pestaña Historial y ve
                    en el mapa por dónde caminó cada equipo.
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

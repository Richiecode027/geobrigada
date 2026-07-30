import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap } from '../components/useMap.js';
import { iniciarGPS, obtenerPosicionActual } from '../lib/gps.js';
import { registrarAtras } from '../lib/atras.js';
import { comprimirImagen } from '../lib/imagen.js';
import {
  cargarBardas,
  bardasPendientes,
  bardasSinUbicacion,
  rutaDeBardasPorCalles,
  largoDeRuta
} from '../lib/bardas.js';
import {
  nubeConfigurada,
  cargarPermisosBardas,
  guardarPermisoBarda,
  anularPermisoBarda,
  cargarBardasNuevas,
  guardarBardaNueva,
  subirFotoBardaNueva
} from '../lib/nube.js';

// Una fila de bardas_nuevas (la sube el equipo desde la app) al mismo formato
// que usa el resto de la vista para una barda del catálogo.
function aBardaCatalogo(n) {
  return {
    id: n.id,
    brigada: null,
    direccion: n.direccion,
    colonia: n.colonia,
    distrito: n.distrito,
    lat: n.lat,
    lng: n.lng,
    foto: n.foto,
    referencia: null
  };
}

const idNuevo = () =>
  'n-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));

// Las fotos del catálogo (Excel) son rutas locales ("bardas-fotos/1.jpg");
// las de bardas agregadas desde la app son URLs completas de Supabase Storage.
const urlFoto = (foto) => (/^https?:/.test(foto) ? foto : import.meta.env.BASE_URL + foto);

const CANTIDAD_SUGERIDA = 10;

function metrosBonito(m) {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

// Quita acentos y mayúsculas para buscar sin que estorben.
const normalizar = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Pin numerado: verde = con permiso, rojo = sin permiso, azul = en la ruta de
// hoy (con su número de orden), gris = pendiente pero fuera de la ruta.
function pinBarda(latlng, texto, color) {
  return L.marker(latlng, {
    icon: L.divIcon({
      className: 'pin-barda',
      html: `<div style="background:${color}">${texto}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    })
  });
}

export default function Bardas() {
  const mapaRef = useRef(null);
  const map = useMap(mapaRef);
  const capaBardas = useRef(null);
  const capaYo = useRef(null);
  const detenerGPS = useRef(null);
  const yaCalculada = useRef(false);

  const [todas, setTodas] = useState([]);
  const [permisos, setPermisos] = useState([]);
  const [miPos, setMiPos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [gpsError, setGpsError] = useState('');

  // 'config' = antes de empezar (equipo, cuántas bardas) · 'recorrido' = en camino
  const [fase, setFase] = useState('config');
  const [equipo, setEquipo] = useState('');
  const [cantidad, setCantidad] = useState(String(CANTIDAD_SUGERIDA));
  const [ruta, setRuta] = useState([]);
  const [porCalles, setPorCalles] = useState(false);
  const [calculando, setCalculando] = useState(false);

  // Buscador para marcar una barda que alguien hizo SIN la app.
  const [busqueda, setBusqueda] = useState('');
  // En el teléfono el panel se puede plegar (queda solo el asa) para ver el
  // mapa casi a pantalla completa mientras se camina.
  const [panelPlegado, setPanelPlegado] = useState(false);

  const [registrando, setRegistrando] = useState(null);
  const [form, setForm] = useState({ permiso: null, nombre: '', telefono: '', aCambio: '', notas: '' });
  const [guardando, setGuardando] = useState(false);

  // Agregar una barda que no está en el catálogo (la encontró el equipo en la calle).
  const [agregando, setAgregando] = useState(false);
  const [formNueva, setFormNueva] = useState({ direccion: '', colonia: '', archivo: null, previewUrl: null });
  const [posNueva, setPosNueva] = useState(null);
  const [gpsNuevaError, setGpsNuevaError] = useState('');
  const [guardandoNueva, setGuardandoNueva] = useState(false);

  // --- carga inicial: catálogo + lo que ya se visitó -----------------------
  useEffect(() => {
    (async () => {
      try {
        const bardas = await cargarBardas();
        let todasConNuevas = bardas;
        if (nubeConfigurada()) {
          try {
            setPermisos(await cargarPermisosBardas());
          } catch {
            setError(
              'No se pudo leer de la nube qué bardas ya se visitaron; se muestran todas como pendientes.'
            );
          }
          try {
            const nuevas = await cargarBardasNuevas();
            todasConNuevas = [...bardas, ...nuevas.map(aBardaCatalogo)];
          } catch {
            /* si falla, se sigue solo con el catálogo del Excel */
          }
        }
        setTodas(todasConNuevas);
      } catch (e) {
        setError(e.message);
      }
      setCargando(false);
    })();
    return () => {
      if (detenerGPS.current) detenerGPS.current();
    };
  }, []);

  const permisosVigentes = useMemo(() => permisos.filter((p) => !p.anulado), [permisos]);
  const pendientes = useMemo(() => bardasPendientes(todas, permisos), [todas, permisos]);
  const sinUbicacion = useMemo(() => bardasSinUbicacion(todas, permisos), [todas, permisos]);
  const visitadas = permisosVigentes.length;
  const conPermiso = permisosVigentes.filter((p) => p.permiso).length;

  function terminarRecorrido() {
    if (detenerGPS.current) detenerGPS.current();
    detenerGPS.current = null;
    setFase('config');
    setRuta([]);
  }

  // Botón "atrás" de Android: en vez de cerrar la app, cierra lo que esté
  // abierto. Primero el formulario, luego el recorrido; ya en el inicio, sí
  // deja salir.
  useEffect(() => {
    return registrarAtras(() => {
      if (agregando) {
        cerrarAgregar();
        return true;
      }
      if (registrando) {
        setRegistrando(null);
        return true;
      }
      if (fase === 'recorrido') {
        terminarRecorrido();
        return true;
      }
      return false;
    });
  }, [agregando, registrando, fase]);

  // --- agregar una barda que no está en el catálogo -------------------------
  function abrirAgregar() {
    setError('');
    setAgregando(true);
    setFormNueva({ direccion: '', colonia: '', archivo: null, previewUrl: null });
    setPosNueva(null);
    setGpsNuevaError('');
    obtenerPosicionActual()
      .then((p) => setPosNueva([p.lat, p.lng]))
      .catch((e) => setGpsNuevaError(e.message));
  }

  function cerrarAgregar() {
    if (formNueva.previewUrl) URL.revokeObjectURL(formNueva.previewUrl);
    setAgregando(false);
  }

  async function guardarNueva() {
    if (!posNueva) return;
    setGuardandoNueva(true);
    const id = idNuevo();
    let foto = null;
    if (formNueva.archivo) {
      try {
        const comprimida = await comprimirImagen(formNueva.archivo);
        foto = await subirFotoBardaNueva(id, comprimida);
      } catch {
        /* si falla la foto, se guarda la barda igual (la ubicación es lo importante) */
      }
    }
    const fila = {
      id,
      direccion: formNueva.direccion.trim() || null,
      colonia: formNueva.colonia.trim() || null,
      distrito: null,
      lat: posNueva[0],
      lng: posNueva[1],
      foto,
      equipo: equipo.trim() || null
    };
    const ok = await guardarBardaNueva(fila);
    setGuardandoNueva(false);
    if (!ok) {
      setError('No se pudo guardar la barda nueva (¿sin señal?). Intenta de nuevo.');
      return;
    }
    setTodas((t) => [...t, aBardaCatalogo(fila)]);
    if (formNueva.previewUrl) URL.revokeObjectURL(formNueva.previewUrl);
    setAgregando(false);
  }

  // --- empezar el recorrido (solo al tocar el botón) -----------------------
  function iniciarRecorrido() {
    setError('');
    setGpsError('');
    yaCalculada.current = false;
    setCalculando(true);
    setFase('recorrido');
    detenerGPS.current = iniciarGPS(
      'bardas',
      (p) => {
        setMiPos([p.lat, p.lng]);
        setGpsError('');
      },
      (msg) => {
        setGpsError(msg);
        setCalculando(false);
      }
    );
  }

  // Con la primera ubicación se arma la ruta (una sola vez: si se recalculara
  // a cada paso del GPS, el orden cambiaría mientras el equipo camina).
  useEffect(() => {
    if (fase !== 'recorrido' || !miPos || yaCalculada.current || pendientes.length === 0) return;
    yaCalculada.current = true;
    (async () => {
      setCalculando(true);
      const cuantas = Math.max(1, parseInt(cantidad, 10) || CANTIDAD_SUGERIDA);
      const r = await rutaDeBardasPorCalles(miPos, pendientes, cuantas);
      setRuta(r.ruta);
      setPorCalles(r.porCalles);
      setCalculando(false);
    })();
  }, [fase, miPos, pendientes, cantidad]);

  // Rehace la ruta con lo que queda pendiente (al registrar o al pedir otras).
  async function recalcular() {
    if (!miPos) return;
    setCalculando(true);
    const cuantas = Math.max(1, parseInt(cantidad, 10) || CANTIDAD_SUGERIDA);
    const r = await rutaDeBardasPorCalles(miPos, pendientes, cuantas);
    setRuta(r.ruta);
    setPorCalles(r.porCalles);
    setCalculando(false);
  }

  // --- mapa ----------------------------------------------------------------
  useEffect(() => {
    if (!map) return;
    if (capaBardas.current) capaBardas.current.remove();
    const g = L.layerGroup().addTo(map);
    const porId = new Map(permisosVigentes.map((p) => [String(p.barda_id), p]));
    const enRuta = new Map(ruta.map((b, i) => [String(b.id), i + 1]));

    for (const b of todas) {
      if (b.lat == null) continue;
      const visita = porId.get(String(b.id));
      const orden = enRuta.get(String(b.id));
      let color = '#9aa5b1';
      let texto = '';
      if (visita) {
        color = visita.permiso ? '#2a9d3a' : '#c1121f';
        texto = visita.permiso ? '✓' : '✕';
      } else if (orden) {
        color = '#1d6fd1';
        texto = String(orden);
      }
      pinBarda([b.lat, b.lng], texto, color)
        .bindTooltip(
          `<strong>${b.direccion || 'Barda ' + b.id}</strong><br>${b.colonia || ''}` +
            (visita ? `<br>${visita.permiso ? '✅ Con permiso' : '❌ Sin permiso'}` : '')
        )
        .on('click', () => abrirRegistro(b))
        .addTo(g);
    }

    // Trazo del recorrido: por calles reales si se pudieron descargar; si no,
    // línea punteada directa (se avisa en el panel para no engañar).
    if (ruta.length > 0) {
      for (const b of ruta) {
        if (b.trazo && b.trazo.length > 1) {
          L.polyline(b.trazo, { color: '#1d6fd1', weight: 4, opacity: 0.75 }).addTo(g);
        }
      }
      if (!porCalles && miPos) {
        L.polyline([miPos, ...ruta.map((b) => [b.lat, b.lng])], {
          color: '#1d6fd1', weight: 3, opacity: 0.5, dashArray: '6 6'
        }).addTo(g);
      }
    }
    capaBardas.current = g;
  }, [map, todas, permisosVigentes, ruta, porCalles, miPos]);

  // Al plegar o desplegar el panel, el mapa cambia de tamaño: hay que avisarle
  // a Leaflet o se queda con el tamaño viejo y los pines salen corridos.
  useEffect(() => {
    if (!map) return;
    const tid = setTimeout(() => map.invalidateSize({ animate: false }), 80);
    return () => clearTimeout(tid);
  }, [map, panelPlegado]);

  useEffect(() => {
    if (!map || !miPos) return;
    if (capaYo.current) capaYo.current.remove();
    const g = L.layerGroup().addTo(map);
    L.circleMarker(miPos, {
      radius: 8, color: '#fff', weight: 2, fillColor: '#1d6fd1', fillOpacity: 1
    }).bindTooltip('Aquí estás tú').addTo(g);
    capaYo.current = g;
  }, [map, miPos]);

  // Encuadra al armarse la ruta (una vez por ruta nueva).
  const encuadrado = useRef(0);
  useEffect(() => {
    if (!map || ruta.length === 0 || !miPos || encuadrado.current === ruta.length) return;
    map.invalidateSize({ animate: false });
    map.fitBounds(L.latLngBounds([miPos, ...ruta.map((b) => [b.lat, b.lng])]), {
      padding: [40, 40], animate: false
    });
    encuadrado.current = ruta.length;
  }, [map, ruta, miPos]);

  // --- registrar el permiso -------------------------------------------------
  function abrirRegistro(b) {
    const previo = permisosVigentes.find((p) => String(p.barda_id) === String(b.id));
    setRegistrando({ ...b, previo: previo || null });
    setForm(
      previo
        ? {
            permiso: previo.permiso,
            nombre: previo.nombre || '',
            telefono: previo.telefono || '',
            aCambio: previo.a_cambio || '',
            notas: previo.notas || ''
          }
        : { permiso: null, nombre: '', telefono: '', aCambio: '', notas: '' }
    );
  }

  async function guardar() {
    if (!registrando || form.permiso === null) return;
    setGuardando(true);
    const fila = {
      barda_id: String(registrando.id),
      permiso: form.permiso,
      nombre: form.nombre.trim() || null,
      telefono: form.telefono.trim() || null,
      a_cambio: form.aCambio.trim() || null,
      notas: form.notas.trim() || null,
      equipo: equipo.trim() || null,
      lat: miPos ? miPos[0] : null,
      lng: miPos ? miPos[1] : null
    };
    const ok = await guardarPermisoBarda(fila);
    setGuardando(false);
    if (!ok) {
      setError('No se pudo guardar en la nube (¿sin señal?). Intenta de nuevo.');
      return;
    }
    setPermisos((p) => [...p.filter((x) => String(x.barda_id) !== fila.barda_id), fila]);
    // Sale de la ruta de hoy; el resto conserva su orden (no se recalcula sola
    // para no cambiarle el camino al equipo a media jornada).
    setRuta((r) => r.filter((b) => String(b.id) !== fila.barda_id));
    setRegistrando(null);
    setError('');
  }

  async function deshacer(bardaId) {
    if (!window.confirm('¿Quitar este registro? La barda volverá a la lista de pendientes.')) return;
    setGuardando(true);
    const ok = await anularPermisoBarda(String(bardaId));
    setGuardando(false);
    if (!ok) {
      setError('No se pudo deshacer (¿sin señal?). Intenta de nuevo.');
      return;
    }
    setPermisos((p) =>
      p.map((x) => (String(x.barda_id) === String(bardaId) ? { ...x, anulado: true } : x))
    );
    setRegistrando(null);
    setError('');
  }

  function comoLlegar(b) {
    const destino = b.lat != null
      ? `${b.lat},${b.lng}`
      : encodeURIComponent(`${b.direccion || ''} ${b.colonia || ''} Morelia Michoacán`);
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${destino}`, '_blank');
  }

  // --- buscador para marcar una barda hecha sin la app ---------------------
  const resultados = useMemo(() => {
    const q = normalizar(busqueda).trim();
    if (q.length < 2) return [];
    return todas
      .filter((b) => normalizar(b.direccion + ' ' + b.colonia + ' ' + b.id).includes(q))
      .slice(0, 12);
  }, [busqueda, todas]);

  const estadoDe = (b) => permisosVigentes.find((p) => String(p.barda_id) === String(b.id));

  // --- render ---------------------------------------------------------------
  return (
    <div className="contenido">
      <div className="mapa" ref={mapaRef} />
      <div className={'panel' + (panelPlegado ? ' plegado' : '')}>
        {/* Asa (solo en el teléfono): pliega el panel para ver el mapa grande */}
        <button
          type="button"
          className="asa-panel"
          onClick={() => setPanelPlegado(!panelPlegado)}
        >
          <span className="asa-barrita" />
          {panelPlegado ? '▲ Mostrar panel' : '▼ Ocultar panel'}
        </button>
        <h2>Bardas por pedir permiso</h2>

        {cargando && <p>Cargando bardas…</p>}
        {error && <div className="error">{error}</div>}
        {gpsError && <div className="error">{gpsError}</div>}

        {!cargando && (
          <p style={{ fontSize: '0.9rem' }}>
            <strong>{pendientes.length}</strong> pendientes ·{' '}
            <strong>{conPermiso}</strong> con permiso ·{' '}
            <strong>{visitadas - conPermiso}</strong> sin permiso
          </p>
        )}

        {/* ---------- ANTES DE EMPEZAR ---------- */}
        {!cargando && fase === 'config' && (
          <>
            <label className="etiqueta">Tu equipo</label>
            <input
              type="text"
              autoComplete="off"
              value={equipo}
              onChange={(e) => setEquipo(e.target.value)}
            />

            <label className="etiqueta">Cantidad de bardas por hacer hoy</label>
            <input
              type="number"
              autoComplete="off"
              min="1"
              max={Math.max(1, pendientes.length)}
              value={cantidad}
              onChange={(e) => setCantidad(e.target.value)}
            />
            <p className="nota" style={{ marginTop: 0 }}>
              Se te arma la ruta con esas bardas, las más cercanas a donde estés.
            </p>

            <div className="fila" style={{ marginTop: 10 }}>
              <button
                className="boton primario"
                onClick={iniciarRecorrido}
                disabled={pendientes.length === 0}
              >
                🚀 Iniciar recorrido
              </button>
            </div>
            {pendientes.length === 0 && (
              <div className="aviso" style={{ background: '#f0f6ee', borderColor: '#cde3c8' }}>
                🎉 ¡Ya se preguntó en todas las bardas del listado!
              </div>
            )}
          </>
        )}

        {/* ---------- EN RECORRIDO ---------- */}
        {fase === 'recorrido' && (
          <>
            {calculando && (
              <div className="aviso">
                ⏳ {miPos ? 'Trazando la ruta por las calles…' : 'Buscando tu ubicación…'}
              </div>
            )}

            {ruta.length > 0 && (
              <>
                <h3>
                  Tu ruta de hoy ({ruta.length} bardas · {metrosBonito(largoDeRuta(ruta))})
                </h3>
                <p className="nota" style={{ marginTop: 0 }}>
                  {porCalles
                    ? 'Distancias y trazo por calles reales. Se eligió la zona con más bardas juntas cerca de ti.'
                    : 'No se pudieron bajar las calles (¿sin señal?): el orden y las distancias son en línea recta.'}
                </p>
                {/* Si no hay bardas cerca, el primer tramo es largo: mejor
                    decirlo de frente que dejar al equipo descubrirlo caminando. */}
                {ruta[0] && ruta[0].metrosDesdeAnterior > 1200 && (
                  <div className="aviso">
                    🚗 La barda más cercana está a{' '}
                    <strong>{metrosBonito(ruta[0].metrosDesdeAnterior)}</strong> de donde
                    estás: conviene trasladarse hasta allá. Ya en la zona, las demás
                    quedan a pocos metros entre sí.
                  </div>
                )}
                <ul className="lista-calles">
                  {ruta.map((b, i) => (
                    <li key={b.id} onClick={() => abrirRegistro(b)} style={{ cursor: 'pointer' }}>
                      <span>
                        <strong>{i + 1}.</strong> {b.direccion || 'Barda ' + b.id}
                        {b.foto ? ' 📷' : ''}
                        <br />
                        <span style={{ fontSize: '0.8rem', color: '#666' }}>
                          {b.colonia}
                          {b.metrosDesdeAnterior != null
                            ? ` · a ${metrosBonito(b.metrosDesdeAnterior)}`
                            : ''}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="fila" style={{ marginTop: 8 }}>
                  <button className="boton suave mini" onClick={recalcular} disabled={calculando}>
                    🔄 Recalcular desde donde estoy
                  </button>
                </div>
              </>
            )}

            {!calculando && ruta.length === 0 && miPos && (
              <div className="aviso" style={{ background: '#f0f6ee', borderColor: '#cde3c8' }}>
                ✅ Terminaste tu ruta.
                <div className="fila" style={{ marginTop: 8 }}>
                  <button className="boton primario mini" onClick={recalcular}>
                    Pedir otras {Math.max(1, parseInt(cantidad, 10) || CANTIDAD_SUGERIDA)} bardas
                  </button>
                </div>
              </div>
            )}

            <div className="fila" style={{ marginTop: 6 }}>
              <button className="boton suave mini" onClick={terminarRecorrido}>
                ⏹ Terminar recorrido
              </button>
            </div>
          </>
        )}

        {/* ---------- AGREGAR UNA BARDA QUE NO ESTÁ EN EL CATÁLOGO ---------- */}
        {!cargando && (
          <>
            <h3>¿Encontraste una barda que no está en la lista?</h3>
            {!agregando ? (
              <div className="fila" style={{ marginTop: 0 }}>
                <button className="boton suave mini" onClick={abrirAgregar}>
                  ➕ Agregar barda nueva
                </button>
              </div>
            ) : (
              <div className="tarjeta-equipo" style={{ borderLeftColor: '#1d6fd1' }}>
                <label className="etiqueta">Dirección (opcional)</label>
                <input
                  type="text"
                  autoComplete="off"
                  value={formNueva.direccion}
                  onChange={(e) => setFormNueva((f) => ({ ...f, direccion: e.target.value }))}
                />

                <label className="etiqueta">Colonia (opcional)</label>
                <input
                  type="text"
                  autoComplete="off"
                  value={formNueva.colonia}
                  onChange={(e) => setFormNueva((f) => ({ ...f, colonia: e.target.value }))}
                />

                <label className="etiqueta">Foto (opcional)</label>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => {
                    const archivo = e.target.files?.[0] || null;
                    if (formNueva.previewUrl) URL.revokeObjectURL(formNueva.previewUrl);
                    setFormNueva((f) => ({
                      ...f,
                      archivo,
                      previewUrl: archivo ? URL.createObjectURL(archivo) : null
                    }));
                  }}
                />
                {formNueva.previewUrl && (
                  <img
                    src={formNueva.previewUrl}
                    alt=""
                    style={{
                      width: '100%',
                      maxHeight: 180,
                      objectFit: 'cover',
                      borderRadius: 8,
                      marginTop: 8
                    }}
                  />
                )}

                <div className="aviso" style={{ marginTop: 8 }}>
                  {posNueva
                    ? `📍 Ubicación lista (${posNueva[0].toFixed(5)}, ${posNueva[1].toFixed(5)})`
                    : gpsNuevaError
                    ? `⚠ ${gpsNuevaError}`
                    : '📍 Obteniendo tu ubicación…'}
                  {gpsNuevaError && (
                    <div className="fila" style={{ marginTop: 6 }}>
                      <button className="boton suave mini" onClick={abrirAgregar}>
                        🔄 Reintentar
                      </button>
                    </div>
                  )}
                </div>

                <div className="fila" style={{ marginTop: 8 }}>
                  <button
                    className="boton primario mini"
                    onClick={guardarNueva}
                    disabled={guardandoNueva || !posNueva}
                  >
                    {guardandoNueva ? 'Guardando…' : '✅ Guardar barda'}
                  </button>
                  <button className="boton suave mini" onClick={cerrarAgregar}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ---------- MARCAR UNA BARDA HECHA SIN LA APP ---------- */}
        {!cargando && (
          <>
            <h3>¿Ya se hizo una barda sin la app?</h3>
            <p className="nota" style={{ marginTop: 0 }}>
              Búscala por dirección o colonia y márcala, aunque no esté en tu ruta.
            </p>
            <input
              type="text"
              autoComplete="off"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
            />
            {resultados.map((b) => {
              const est = estadoDe(b);
              return (
                <div key={b.id} className="resultado" onClick={() => abrirRegistro(b)}>
                  <strong>{b.direccion || 'Barda ' + b.id}</strong>
                  {b.foto ? ' 📷' : ''}
                  <div style={{ fontSize: '0.8rem', color: '#666' }}>
                    {b.colonia}
                    {est ? (est.permiso ? ' · ✅ con permiso' : ' · ❌ sin permiso') : ' · pendiente'}
                    {b.lat == null ? ' · sin ubicación' : ''}
                  </div>
                </div>
              );
            })}
            {busqueda.trim().length >= 2 && resultados.length === 0 && (
              <div className="aviso">No hay bardas que coincidan con «{busqueda}».</div>
            )}
          </>
        )}

        {/* ---------- BARDAS SIN UBICACIÓN ---------- */}
        {!cargando && sinUbicacion.length > 0 && (
          <>
            <h3>Sin ubicación en el mapa ({sinUbicacion.length})</h3>
            <p className="nota" style={{ marginTop: 0 }}>
              A estas no se les puso link de mapa al capturarlas: hay que buscarlas por
              la dirección.
            </p>
            <ul className="lista-calles">
              {sinUbicacion.map((b) => (
                <li key={b.id} onClick={() => abrirRegistro(b)} style={{ cursor: 'pointer' }}>
                  <span>
                    {b.direccion || 'Barda ' + b.id}
                    {b.foto ? ' 📷' : ''}
                    <br />
                    <span style={{ fontSize: '0.8rem', color: '#666' }}>
                      {b.colonia}
                      {b.referencia && !/^https?:/.test(b.referencia) ? ` · ${b.referencia}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {/* ---------- FORMULARIO ---------- */}
        {registrando && (
          <div className="tarjeta-equipo" style={{ borderLeftColor: '#1d6fd1', marginTop: 12 }}>
            <strong>{registrando.direccion || 'Barda ' + registrando.id}</strong>
            <div className="datos">{registrando.colonia}</div>

            {registrando.previo && (
              <div className="aviso" style={{ background: '#fff8e6', borderColor: '#f0d9a0' }}>
                Esta barda ya se registró como{' '}
                <strong>{registrando.previo.permiso ? 'CON permiso' : 'SIN permiso'}</strong>
                {registrando.previo.equipo ? ` (${registrando.previo.equipo})` : ''}. Puedes
                corregir los datos y volver a guardar, o quitar el registro si fue por error.
              </div>
            )}

            {registrando.foto && (
              <img
                src={urlFoto(registrando.foto)}
                alt="Foto de la barda"
                style={{
                  width: '100%',
                  maxHeight: 220,
                  objectFit: 'cover',
                  borderRadius: 8,
                  margin: '8px 0',
                  cursor: 'zoom-in'
                }}
                onClick={() => window.open(urlFoto(registrando.foto), '_blank')}
              />
            )}

            <div className="fila">
              <button className="boton suave mini" onClick={() => comoLlegar(registrando)}>
                🧭 Cómo llegar
              </button>
            </div>

            <h3>¿Le dieron permiso de pintar?</h3>
            <div className="fila">
              <button
                className={form.permiso === true ? 'boton exito' : 'boton suave'}
                onClick={() => setForm((f) => ({ ...f, permiso: true }))}
              >
                ✅ Sí
              </button>
              <button
                className={form.permiso === false ? 'boton peligro' : 'boton suave'}
                onClick={() => setForm((f) => ({ ...f, permiso: false }))}
              >
                ❌ No
              </button>
            </div>

            <label className="etiqueta">Nombre de quien atendió</label>
            <input
              type="text"
              autoComplete="off"
              value={form.nombre}
              onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
            />

            <label className="etiqueta">Teléfono</label>
            <input
              type="tel"
              autoComplete="off"
              value={form.telefono}
              onChange={(e) => setForm((f) => ({ ...f, telefono: e.target.value }))}
            />

            {form.permiso === true && (
              <>
                <label className="etiqueta">¿Qué se dará a cambio?</label>
                <input
                  type="text"
                  autoComplete="off"
                  value={form.aCambio}
                  onChange={(e) => setForm((f) => ({ ...f, aCambio: e.target.value }))}
                />
              </>
            )}

            <label className="etiqueta">Notas (opcional)</label>
            <textarea
              rows="2"
              value={form.notas}
              onChange={(e) => setForm((f) => ({ ...f, notas: e.target.value }))}
            />

            <div className="fila" style={{ marginTop: 10 }}>
              <button
                className="boton primario"
                onClick={guardar}
                disabled={form.permiso === null || guardando}
              >
                {guardando ? 'Guardando…' : 'Guardar'}
              </button>
              <button className="boton suave" onClick={() => setRegistrando(null)}>
                Cancelar
              </button>
            </div>
            {form.permiso === null && (
              <p className="nota" style={{ marginTop: 6 }}>
                Marca primero si dieron permiso o no.
              </p>
            )}
            {registrando.previo && (
              <div className="fila" style={{ marginTop: 4 }}>
                <button
                  className="boton peligro mini"
                  onClick={() => deshacer(registrando.id)}
                  disabled={guardando}
                >
                  ↩ Quitar este registro (fue por error)
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

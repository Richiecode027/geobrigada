import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap } from '../components/useMap.js';
import { iniciarGPS } from '../lib/gps.js';
import { haversine } from '../lib/geo.js';
import {
  cargarBardas,
  bardasPendientes,
  bardasSinUbicacion,
  rutaDeBardas,
  largoDeRuta
} from '../lib/bardas.js';
import {
  nubeConfigurada,
  cargarPermisosBardas,
  guardarPermisoBarda,
  anularPermisoBarda
} from '../lib/nube.js';

// Cuántas bardas propone la ruta de una jornada.
const BARDAS_POR_RUTA = 15;

function metrosBonito(m) {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

// Pin numerado: verde = ya con permiso, rojo = ya visitada sin permiso,
// azul = pendiente (el número es el orden de la ruta propuesta).
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

  const [todas, setTodas] = useState([]);
  const [permisos, setPermisos] = useState([]);
  const [miPos, setMiPos] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [gpsError, setGpsError] = useState('');
  const [equipo, setEquipo] = useState('');
  // Barda que se está registrando ahora mismo (abre el formulario).
  const [registrando, setRegistrando] = useState(null);
  const [form, setForm] = useState({ permiso: null, nombre: '', telefono: '', aCambio: '', notas: '' });
  const [guardando, setGuardando] = useState(false);

  // --- carga inicial: catálogo + lo que ya se visitó -----------------------
  useEffect(() => {
    (async () => {
      try {
        const bardas = await cargarBardas();
        setTodas(bardas);
        if (nubeConfigurada()) {
          try {
            setPermisos(await cargarPermisosBardas());
          } catch {
            setError('No se pudo leer de la nube qué bardas ya se visitaron; ' +
              'se muestran todas como pendientes.');
          }
        }
      } catch (e) {
        setError(e.message);
      }
      setCargando(false);
    })();
  }, []);

  // --- GPS: la ruta se arma desde donde está parado el equipo --------------
  useEffect(() => {
    detenerGPS.current = iniciarGPS(
      'bardas',
      (p) => {
        setMiPos([p.lat, p.lng]);
        setGpsError('');
      },
      (msg) => setGpsError(msg)
    );
    return () => {
      if (detenerGPS.current) detenerGPS.current();
    };
  }, []);

  const pendientes = useMemo(() => bardasPendientes(todas, permisos), [todas, permisos]);
  const sinUbicacion = useMemo(() => bardasSinUbicacion(todas, permisos), [todas, permisos]);

  // Ruta propuesta: las más cercanas primero, desde mi ubicación.
  const ruta = useMemo(
    () => (miPos ? rutaDeBardas(miPos, pendientes, BARDAS_POR_RUTA) : []),
    [miPos, pendientes]
  );

  // Los registros anulados (se tocó la barda equivocada) no cuentan.
  const permisosVigentes = useMemo(() => permisos.filter((p) => !p.anulado), [permisos]);
  const visitadas = permisosVigentes.length;
  const conPermiso = permisosVigentes.filter((p) => p.permiso).length;

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
      let color = '#9aa5b1'; // pendiente pero fuera de la ruta de hoy
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
        // También se abre si ya se visitó: para corregir o deshacer el registro.
        .on('click', () => abrirRegistro(b))
        .addTo(g);
    }

    // Línea del recorrido propuesto, desde mi ubicación.
    if (miPos && ruta.length > 0) {
      L.polyline([miPos, ...ruta.map((b) => [b.lat, b.lng])], {
        color: '#1d6fd1',
        weight: 3,
        opacity: 0.6,
        dashArray: '6 6'
      }).addTo(g);
    }
    capaBardas.current = g;
  }, [map, todas, permisos, ruta, miPos]);

  // Mi ubicación (punto azul), sin pelear con el zoom del usuario.
  useEffect(() => {
    if (!map || !miPos) return;
    if (capaYo.current) capaYo.current.remove();
    const g = L.layerGroup().addTo(map);
    L.circleMarker(miPos, {
      radius: 8, color: '#fff', weight: 2, fillColor: '#1d6fd1', fillOpacity: 1
    }).bindTooltip('Aquí estás tú').addTo(g);
    capaYo.current = g;
  }, [map, miPos]);

  // Encuadra una sola vez, cuando ya hay ruta que mostrar.
  const encuadrado = useRef(false);
  useEffect(() => {
    if (!map || encuadrado.current || ruta.length === 0 || !miPos) return;
    map.invalidateSize({ animate: false });
    map.fitBounds(L.latLngBounds([miPos, ...ruta.map((b) => [b.lat, b.lng])]), {
      padding: [40, 40],
      animate: false
    });
    encuadrado.current = true;
  }, [map, ruta, miPos]);

  // --- registrar el permiso -------------------------------------------------
  // Si la barda ya se había registrado, se abre con sus datos: así se puede
  // corregir lo que se escribió mal o deshacer el registro completo.
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
    // Se refleja de inmediato: la barda sale de pendientes y la ruta se recalcula.
    setPermisos((p) => [...p.filter((x) => String(x.barda_id) !== fila.barda_id), fila]);
    setRegistrando(null);
    setError('');
  }

  // Deshacer un registro equivocado: la barda vuelve a la lista de pendientes.
  async function deshacer(bardaId) {
    if (!window.confirm('¿Quitar este registro? La barda volverá a la lista de pendientes.')) {
      return;
    }
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
    // Con coordenadas se abre la navegación al punto exacto; sin ellas, se
    // busca por dirección y colonia (es lo único que se tiene de esa barda).
    const destino = b.lat != null
      ? `${b.lat},${b.lng}`
      : encodeURIComponent(`${b.direccion || ''} ${b.colonia || ''} Morelia Michoacán`);
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${destino}`, '_blank');
  }

  // --- render ---------------------------------------------------------------
  return (
    <div className="contenido">
      <div className="mapa" ref={mapaRef} />
      <div className="panel">
        <h2>Bardas por pedir permiso</h2>

        {cargando && <p>Cargando bardas…</p>}
        {error && <div className="error">{error}</div>}
        {gpsError && <div className="error">{gpsError}</div>}

        {!cargando && (
          <>
            <p style={{ fontSize: '0.9rem' }}>
              <strong>{pendientes.length}</strong> pendientes ·{' '}
              <strong>{conPermiso}</strong> con permiso ·{' '}
              <strong>{visitadas - conPermiso}</strong> sin permiso
            </p>

            <label className="etiqueta">Tu equipo (para saber quién registró)</label>
            <input
              type="text"
              autoComplete="off"
              value={equipo}
              onChange={(e) => setEquipo(e.target.value)}
            />

            {!miPos && !gpsError && (
              <div className="aviso">
                📡 Buscando tu ubicación… en cuanto la tenga, te armo la ruta con las
                bardas más cercanas.
              </div>
            )}

            {ruta.length > 0 && (
              <>
                <h3>
                  Tu ruta de hoy ({ruta.length} bardas · {metrosBonito(largoDeRuta(ruta))})
                </h3>
                <p className="nota" style={{ marginTop: 0 }}>
                  Van de la más cercana a la más lejana desde donde estás. Toca una para
                  registrar si te dieron permiso.
                </p>
                <ul className="lista-calles">
                  {ruta.map((b, i) => (
                    <li key={b.id} onClick={() => abrirRegistro(b)} style={{ cursor: 'pointer' }}>
                      <span>
                        <strong>{i + 1}.</strong> {b.direccion || 'Barda ' + b.id}
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
              </>
            )}

            {miPos && pendientes.length === 0 && (
              <div className="aviso" style={{ background: '#f0f6ee', borderColor: '#cde3c8' }}>
                🎉 ¡Ya se preguntó en todas las bardas del listado!
              </div>
            )}

            {/* Bardas que no traían ubicación: no salen en el mapa ni en la
                ruta, pero hay que ir igual, así que se listan por dirección. */}
            {sinUbicacion.length > 0 && (
              <>
                <h3>Sin ubicación en el mapa ({sinUbicacion.length})</h3>
                <p className="nota" style={{ marginTop: 0 }}>
                  A estas no se les puso link de mapa al capturarlas: hay que
                  buscarlas por la dirección.
                </p>
                <ul className="lista-calles">
                  {sinUbicacion.map((b) => (
                    <li key={b.id} onClick={() => abrirRegistro(b)} style={{ cursor: 'pointer' }}>
                      <span>
                        {b.direccion || 'Barda ' + b.id}
                        <br />
                        <span style={{ fontSize: '0.8rem', color: '#666' }}>
                          {b.colonia}
                          {b.referencia && !/^https?:/.test(b.referencia)
                            ? ` · ${b.referencia}`
                            : ''}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}

        {/* --- formulario de la barda seleccionada --- */}
        {registrando && (
          <div className="tarjeta-equipo" style={{ borderLeftColor: '#1d6fd1', marginTop: 12 }}>
            <strong>{registrando.direccion || 'Barda ' + registrando.id}</strong>
            <div className="datos">
              {registrando.colonia}
              {registrando.referencia ? ' · ' : ''}
            </div>

            {/* Ya registrada: se puede corregir lo escrito o deshacerlo todo. */}
            {registrando.previo && (
              <div className="aviso" style={{ background: '#fff8e6', borderColor: '#f0d9a0' }}>
                Esta barda ya se registró como{' '}
                <strong>{registrando.previo.permiso ? 'CON permiso' : 'SIN permiso'}</strong>
                {registrando.previo.equipo ? ` (${registrando.previo.equipo})` : ''}. Puedes
                corregir los datos y volver a guardar, o quitar el registro si fue
                por error.
              </div>
            )}

            <div className="fila">
              <button className="boton suave mini" onClick={() => comoLlegar(registrando)}>
                🧭 Cómo llegar
              </button>
              {registrando.foto && (
                <button
                  className="boton suave mini"
                  onClick={() => window.open(registrando.foto, '_blank')}
                >
                  📷 Ver foto
                </button>
              )}
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

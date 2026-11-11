import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap, marcadorInicio, marcadorEncuentro, marcadorFin } from '../components/useMap.js';
import AsaPanel from '../components/AsaPanel.jsx';
import DatosCenso from '../components/DatosCenso.jsx';
import { useMiUbicacion } from '../components/useMiUbicacion.js';
import { buscarColonias, ringsPorClave, coloniaEnPunto, coloniaPorClave } from '../lib/colonias.js';
import { obtenerCallesDePartes } from '../api/overpass.js';
import { buildUnits } from '../lib/units.js';
import { partition, orderRoute, recorridoContinuo, puntoDeEncuentro, TEAM_COLORS } from '../lib/partition.js';
import { ringsBounds } from '../lib/geo.js';
import { linkEquipo } from '../lib/links.js';
import { cargarActividades, recordarActividad } from '../lib/storage.js';

export default function Coordinador({ contexto }) {
  const mapaRef = useRef(null);
  const panelRef = useRef(null);
  const map = useMap(mapaRef);

  const capaColonia = useRef(null);
  const capaEquipos = useRef(null);
  const capaDibujo = useRef(null);

  const [query, setQuery] = useState('');
  const [resultados, setResultados] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [colonia, setColonia] = useState(null);
  const [nEquipos, setNEquipos] = useState(2);
  const [actividad, setActividad] = useState('');
  const [campana, setCampana] = useState('');
  const [brigada, setBrigada] = useState('');
  const [actividadesGuardadas, setActividadesGuardadas] = useState(cargarActividades());
  const [equipos, setEquipos] = useState(null);
  const [encuentro, setEncuentro] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [dibujando, setDibujando] = useState(false);
  const [puntos, setPuntos] = useState([]);
  const [copiado, setCopiado] = useState(-1);
  const [gpsError, setGpsError] = useState('');
  // En el teléfono, mientras se busca se oculta el mapa: así la lista de
  // resultados usa toda la pantalla y no queda aplastada por el teclado.
  const [buscadorEnfocado, setBuscadorEnfocado] = useState(false);
  const busquedaActiva =
    buscadorEnfocado || Boolean(resultados && resultados.length > 0);
  // En el teléfono el panel se puede plegar (queda solo el asa) para ver el
  // mapa casi a pantalla completa.
  const [panelPlegado, setPanelPlegado] = useState(false);

  // --- búsqueda (catálogo local de 866 colonias de Morelia) ---------------
  async function buscar(e) {
    if (e) e.preventDefault();
    if (query.trim().length < 2) return;
    setBuscando(true);
    setError('');
    try {
      const res = await buscarColonias(query);
      setResultados(res);
      setAviso(
        res.length === 0
          ? 'No se encontró esa colonia en el catálogo. Puedes ubicarla a ojo y usar "Dibujar colonia a mano".'
          : ''
      );
    } catch (err) {
      setError('Error al buscar: ' + err.message);
    }
    setBuscando(false);
  }

  // Búsqueda en vivo mientras se escribe.
  useEffect(() => {
    if (query.trim().length < 2) {
      setResultados(null);
      return;
    }
    const tid = setTimeout(buscar, 250);
    return () => clearTimeout(tid);
  }, [query]);

  // Cuando la vista Brigadas manda una colonia a planear: la precarga junto con
  // sus etiquetas (campaña, actividad, brigada).
  useEffect(() => {
    if (!contexto) return;
    (async () => {
      setCampana(contexto.campana || '');
      setActividad(contexto.actividad || '');
      setBrigada(contexto.brigada || '');
      setEquipos(null);
      setAviso('');
      const rings = await ringsPorClave(contexto.clave);
      const datos = await coloniaPorClave(contexto.clave);
      if (rings) {
        setAgregandoOtra(false);
        setColonia(zonaDe([{ k: contexto.clave, n: contexto.nombre, rings, datos: datos || {} }]));
      }
    })();
  }, [contexto && contexto.sello]);

  // --- varias colonias juntas -------------------------------------------
  // Cuando asignan varias colonias a la vez: con "Agregar otra colonia"
  // prendido, la siguiente que se elija (buscador o toque largo) se SUMA a la
  // zona en vez de reemplazarla. La zona es una "colonia" más: clave con las
  // claves separadas por comas (en orden, ver colonias.js), anillos de todas y
  // viviendas sumadas, así que el reparto, los links y la Cobertura no
  // necesitan saber que son varias.
  const [agregandoOtra, setAgregandoOtra] = useState(false);

  function zonaDe(partes) {
    if (partes.length === 1) {
      const p = partes[0];
      return { nombre: p.n, clave: p.k, rings: p.rings, tienePoligono: true, viviendas: p.datos.v, censo: p.datos, partes };
    }
    const suma = (c) => partes.reduce((a, p) => a + (p.datos[c] || 0), 0);
    return {
      nombre: partes.map((p) => p.n).join(' + '),
      clave: partes.map((p) => p.k).join(','),
      rings: partes.flatMap((p) => p.rings),
      tienePoligono: true,
      viviendas: suma('v'),
      censo: { v: suma('v'), vt: suma('vt'), p: suma('p') },
      partes
    };
  }

  // c: zona del catálogo ({k, n, v, vt, p...}); rings: su contorno.
  function ponerColonia(c, rings) {
    setEquipos(null);
    setAviso('');
    const nueva = { k: c.k, n: c.n, rings, datos: c };
    if (agregandoOtra && colonia && colonia.partes) {
      setAgregandoOtra(false);
      if (colonia.partes.some((p) => p.k === c.k)) {
        setAviso(`"${c.n}" ya está en la zona.`);
        return;
      }
      setColonia(zonaDe([...colonia.partes, nueva]));
    } else {
      setColonia(zonaDe([nueva]));
    }
  }

  function quitarParte(k) {
    setEquipos(null);
    const quedan = colonia.partes.filter((p) => p.k !== k);
    setColonia(quedan.length ? zonaDe(quedan) : null);
  }

  async function elegirResultado(r) {
    setResultados(null);
    setEquipos(null);
    setAviso('');
    const rings = await ringsPorClave(r.k);
    if (rings) {
      ponerColonia(r, rings);
    } else {
      setColonia(null);
      setAviso(
        `"${r.n}" está en el catálogo pero sin polígono disponible. ` +
          'Usa "Dibujar colonia a mano": toca el mapa siguiendo el contorno de la colonia y al final presiona "Terminar dibujo".'
      );
    }
  }

  // --- seleccionar colonia tocando el mapa (pulsación larga / clic derecho) --
  async function seleccionarEnPunto(latlng) {
    setResultados(null);
    const c = await coloniaEnPunto(latlng.lat, latlng.lng);
    if (c) {
      ponerColonia(c, c.rings);
    } else {
      setAviso('Ahí no hay ninguna colonia del catálogo. Toca dentro de una zona urbana de Morelia.');
    }
  }

  useEffect(() => {
    if (!map || dibujando) return; // al dibujar a mano, el toque agrega puntos
    const alTocarLargo = (e) => seleccionarEnPunto(e.latlng);
    map.on('contextmenu', alTocarLargo);
    return () => map.off('contextmenu', alTocarLargo);
    // colonia y agregandoOtra van en la lista: si no, el toque largo usaría
    // una copia vieja y no sabría que hay que SUMAR la colonia a la zona.
  }, [map, dibujando, colonia, agregandoOtra]);

  // --- dibujo manual ----------------------------------------------------
  function iniciarDibujo() {
    setDibujando(true);
    setPuntos([]);
    setColonia(null);
    setAgregandoOtra(false);
    setEquipos(null);
    setAviso('Toca el mapa para marcar el contorno de la colonia (mínimo 3 puntos).');
  }

  function terminarDibujo() {
    if (puntos.length < 3) return;
    setColonia({
      nombre: query.trim() || 'Colonia dibujada',
      osmRef: null,
      tienePoligono: true,
      rings: [puntos],
      centro: puntos[0]
    });
    setDibujando(false);
    setPuntos([]);
    setAviso('');
  }

  useEffect(() => {
    if (!map || !dibujando) return;
    const alClic = (e) => setPuntos((p) => [...p, [e.latlng.lat, e.latlng.lng]]);
    map.on('click', alClic);
    map.getContainer().style.cursor = 'crosshair';
    return () => {
      map.off('click', alClic);
      map.getContainer().style.cursor = '';
    };
  }, [map, dibujando]);

  useEffect(() => {
    if (!map) return;
    if (capaDibujo.current) capaDibujo.current.remove();
    if (!dibujando || puntos.length === 0) return;
    const g = L.layerGroup().addTo(map);
    puntos.forEach((p) =>
      L.circleMarker(p, { radius: 5, color: '#c1121f', fillOpacity: 1 }).addTo(g)
    );
    if (puntos.length > 1) {
      L.polyline(puntos, { color: '#c1121f', dashArray: '6 4' }).addTo(g);
    }
    capaDibujo.current = g;
  }, [map, puntos, dibujando]);

  // --- dibujar colonia seleccionada --------------------------------------
  useEffect(() => {
    if (!map) return;
    if (capaColonia.current) capaColonia.current.remove();
    if (!colonia) return;
    const g = L.layerGroup().addTo(map);
    colonia.rings.forEach((r) =>
      L.polygon(r, {
        color: '#1d3557',
        weight: 3,
        fillColor: '#457b9d',
        fillOpacity: 0.08
      }).addTo(g)
    );
    capaColonia.current = g;
  }, [map, colonia]);

  // Encuadra la colonia elegida. Espera a que el mapa esté VISIBLE (no oculto
  // por el buscador ni por el panel plegado) y le avisa a Leaflet el tamaño
  // real del contenedor antes de calcular el zoom: si no, usa un tamaño
  // guardado en caché de cuando estaba oculto y el encuadre sale mal. Sin
  // animación: justo al reaparecer, la animación de zoom de Leaflet alcanza
  // a calcular el encuadre con un zoom todavía en transición y sale mal.
  useEffect(() => {
    if (!map || !colonia || busquedaActiva) return;
    const tid = setTimeout(() => {
      map.invalidateSize({ animate: false });
      map.fitBounds(ringsBounds(colonia.rings), { padding: [20, 20], animate: false });
    }, 80);
    return () => clearTimeout(tid);
  }, [map, colonia, busquedaActiva, panelPlegado]);

  // --- mi ubicación (para saber hacia dónde caminar a la colonia) ----------
  // Aparece sola (mismo marcador que en todos los mapas); el botón solo centra.
  const miUbicacion = useMiUbicacion(map);
  function centrarEnMi() {
    setGpsError(
      miUbicacion.centrar(16)
        ? ''
        : 'Todavía no tengo tu ubicación. Revisa que el navegador tenga permiso de ubicación.'
    );
  }

  // --- generar rutas ------------------------------------------------------
  async function generarRutas() {
    setError('');
    setCargando(true);
    setEquipos(null);
    try {
      const calles = await obtenerCallesDePartes(
        colonia.partes ? colonia.partes.map((p) => p.rings) : [colonia.rings]
      );
      const units = buildUnits(calles, colonia.rings);
      if (units.length === 0) {
        throw new Error(
          'No se encontraron calles dentro del área. Revisa que el contorno cubra la colonia.'
        );
      }
      const inicio = puntoDeEncuentro(units);
      const grupos = partition(units, nEquipos);
      const eq = grupos.map((g, i) => {
        const ruta = orderRoute(g, inicio);
        const metros = ruta.reduce((s, u) => s + u.length, 0);
        return { ruta, km: metros / 1000, color: TEAM_COLORS[i % TEAM_COLORS.length] };
      });
      setEncuentro(inicio);
      setEquipos(eq);
      // Recuerda la actividad usada para sugerirla la próxima vez.
      setActividadesGuardadas(recordarActividad(actividad.trim() || 'Reparto'));
    } catch (err) {
      setError(err.message);
    }
    setCargando(false);
  }

  useEffect(() => {
    if (!map) return;
    if (capaEquipos.current) capaEquipos.current.remove();
    if (!equipos) return;
    const g = L.layerGroup().addTo(map);
    equipos.forEach((eq, i) => {
      // Recorrido continuo de cada equipo: tramos a repartir (sólido) y
      // conectores de reposicionamiento (punteado). Con varios equipos a la
      // vez las flechas de sentido se amontonaban y no se entendían; se quitan
      // aquí (el brigadista sí las ve, una a la vez, en su propio teléfono).
      const pasos = recorridoContinuo(eq.ruta);
      pasos.forEach((p) =>
        p.tipo === 'cubrir'
          ? L.polyline(p.coords, { color: eq.color, weight: 5, opacity: 0.5 }).addTo(g)
          : L.polyline(p.coords, { color: eq.color, weight: 3, opacity: 0.55, dashArray: '2 9' }).addTo(g)
      );
      marcadorInicio(eq.ruta[0].coords[0], i + 1, eq.color).addTo(g);
      const fin = pasos[pasos.length - 1]?.coords.slice(-1)[0];
      if (fin) marcadorFin(fin).addTo(g);
    });
    if (encuentro) marcadorEncuentro(encuentro).addTo(g);
    capaEquipos.current = g;
  }, [map, equipos]);

  // --- compartir ----------------------------------------------------------
  const nombreActividad = actividad.trim() || 'Reparto';

  // Viviendas estimadas por equipo: se reparten en proporción a sus km de calle
  // (asume que las casas están repartidas de forma pareja a lo largo de la red).
  function vivEquipo(i) {
    if (!equipos || !colonia || !colonia.viviendas) return 0;
    const kmTotal = equipos.reduce((s, e) => s + e.km, 0);
    if (kmTotal <= 0) return 0;
    return Math.round((colonia.viviendas * equipos[i].km) / kmTotal);
  }

  function link(i) {
    return linkEquipo({
      colonia,
      nEquipos: equipos.length,
      equipo: i + 1,
      actividad: nombreActividad,
      campana: campana.trim(),
      brigada: brigada.trim()
    });
  }

  async function copiarLink(i) {
    try {
      await navigator.clipboard.writeText(link(i));
      setCopiado(i);
      setTimeout(() => setCopiado(-1), 2000);
    } catch {
      window.prompt('Copia el link manualmente:', link(i));
    }
  }

  // Encabezado con campaña / brigada cuando vienen del reparto de brigadas.
  function encabezado() {
    let s = '🗺️ GeoBrigada';
    if (campana.trim()) s += ` · ${campana.trim()}`;
    s += ` – ${colonia.nombre} · ${nombreActividad}`;
    if (brigada.trim()) s += ` · ${brigada.trim()}`;
    return s;
  }

  function compartirWhatsApp(i) {
    const viv = vivEquipo(i);
    const texto =
      `${encabezado()}\n` +
      `Eres el *Equipo ${i + 1}* de ${equipos.length}. ` +
      `Tu ruta mide ${equipos[i].km.toFixed(1)} km.\n` +
      (viv > 0 ? `Lleva ~${viv} ${nombreActividad.toLowerCase()} (≈ ${viv} viviendas).\n` : '') +
      `Ábrela aquí y activa tu GPS:\n${link(i)}`;
    window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank');
  }

  // Un solo mensaje con TODOS los links, para mandarlo al grupo de la brigada.
  function compartirTodosWhatsApp() {
    const lineas = equipos.map((eq, i) => {
      const viv = vivEquipo(i);
      return (
        `*Equipo ${i + 1}* (${eq.km.toFixed(1)} km` +
        (viv > 0 ? `, ~${viv} ${nombreActividad.toLowerCase()}` : '') +
        `):\n${link(i)}`
      );
    });
    const texto =
      `${encabezado()} (${equipos.length} equipos)\n` +
      `Cada quien abre SOLO el link de su equipo y activa su GPS:\n\n` +
      lineas.join('\n\n');
    window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank');
  }

  // --- render ---------------------------------------------------------------
  return (
    <div className={'contenido' + (busquedaActiva ? ' busqueda-activa' : '')}>
      <div className="mapa" ref={mapaRef} />
      <div ref={panelRef} className={'panel' + (panelPlegado ? ' plegado' : '')}>
        <AsaPanel plegado={panelPlegado} onCambiar={setPanelPlegado} panelRef={panelRef} />
        <h2>1. Busca la colonia o sección</h2>
        <form onSubmit={buscar} className="fila">
          <input
            type="text"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={(e) => {
              setBuscadorEnfocado(true);
              // Sube el buscador hasta arriba para que la lista quede a la vista.
              const el = e.target;
              setTimeout(() => el.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
            }}
            onBlur={() => setBuscadorEnfocado(false)}
            style={{ flex: 1, minWidth: '180px' }}
          />
          <button className="boton" disabled={buscando}>
            {buscando ? 'Buscando…' : 'Buscar'}
          </button>
        </form>
        <p className="nota" style={{ marginTop: 0 }}>
          💡 O deja el dedo pulsado sobre el mapa para seleccionar la colonia de
          ese punto (en computadora: clic derecho).
        </p>

        <div className="fila">
          <button className="boton suave mini" onClick={centrarEnMi}>
            📍 Centrar en mí
          </button>
          <span style={{ fontSize: '0.8rem', color: '#666' }}>
            para saber hacia dónde caminar a la colonia
          </span>
        </div>
        {gpsError && <div className="error">{gpsError}</div>}

        {resultados &&
          resultados.map((r, i) => (
            <div key={i} className="resultado" onClick={() => elegirResultado(r)}>
              <strong>{r.n}</strong> · {r.t}
              {r.cp ? ` · CP ${r.cp}` : ''}
              {r.vt > 0 && <span style={{ color: '#555' }}> · 🏠 {r.vt} viv.</span>}
              {r.p > 0 && <span style={{ color: '#555' }}> · 👥 {r.p.toLocaleString('es-MX')} hab.</span>}
              <span className="badge ok">✓ límites oficiales</span>
            </div>
          ))}

        {!dibujando ? (
          <div className="fila">
            <button className="boton suave mini" onClick={iniciarDibujo}>
              ✏️ Dibujar colonia a mano
            </button>
          </div>
        ) : (
          <div className="fila">
            <button
              className="boton exito mini"
              onClick={terminarDibujo}
              disabled={puntos.length < 3}
            >
              ✓ Terminar dibujo ({puntos.length} puntos)
            </button>
            {/* Quita solo el último punto: un toque mal puesto ya no obliga a
                cancelar y empezar todo el contorno de nuevo. */}
            <button
              className="boton suave mini"
              onClick={() => setPuntos((p) => p.slice(0, -1))}
              disabled={puntos.length === 0}
            >
              ↩ Quitar último punto
            </button>
            <button className="boton peligro mini" onClick={() => { setDibujando(false); setPuntos([]); }}>
              Cancelar
            </button>
          </div>
        )}

        {aviso && <div className="aviso">{aviso}</div>}
        {error && <div className="error">{error}</div>}

        {colonia && (
          <>
            <h2>2. ¿Qué actividad es y cuántos equipos hay?</h2>
            {(campana.trim() || brigada.trim()) && (
              <div className="aviso" style={{ background: '#f0f6ee', borderColor: '#cde3c8' }}>
                {campana.trim() && <>📣 <strong>{campana.trim()}</strong> · </>}
                {brigada.trim() && <>👥 {brigada.trim()}</>}
              </div>
            )}
            {colonia.partes && colonia.partes.length > 1 ? (
              <div className="tarjeta-equipo" style={{ borderLeftColor: '#457b9d' }}>
                <strong>{colonia.partes.length} colonias juntas</strong>
                {colonia.partes.map((p) => (
                  <div key={p.k} className="fila" style={{ alignItems: 'center', marginTop: 4 }}>
                    <span style={{ flex: 1 }}>{p.n}</span>
                    <button className="boton suave mini" onClick={() => quitarParte(p.k)} aria-label={'Quitar ' + p.n}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="fila">
                <strong style={{ flex: 1 }}>{colonia.nombre}</strong>
              </div>
            )}
            {/* Solo zonas del catálogo se pueden juntar: una dibujada a mano no
                tiene clave para mandarla en el link junto con otras. */}
            {colonia.partes && (
              <div className="fila">
                <button
                  className={agregandoOtra ? 'boton primario mini' : 'boton suave mini'}
                  onClick={() => setAgregandoOtra((v) => !v)}
                >
                  {agregandoOtra ? 'Cancelar' : '➕ Agregar otra colonia'}
                </button>
              </div>
            )}
            {agregandoOtra && (
              <div className="aviso" style={{ background: '#eef4fc', borderColor: '#c3d8f0' }}>
                Busca la siguiente colonia o sección arriba, o mantén presionado
                el mapa sobre ella: se suma a la zona en vez de reemplazarla.
              </div>
            )}
            <DatosCenso c={colonia.censo} />
            <label className="etiqueta">Actividad</label>
            <div className="fila">
              <input
                type="text"
                autoComplete="off"
                list="lista-actividades"
                value={actividad}
                onChange={(e) => setActividad(e.target.value)}
                style={{ flex: 1, minWidth: '160px' }}
              />
              <datalist id="lista-actividades">
                {[...new Set([...actividadesGuardadas, 'Folletos', 'Calendarios', 'Visita'])].map(
                  (a) => (
                    <option key={a} value={a} />
                  )
                )}
              </datalist>
            </div>
            <p className="nota" style={{ marginTop: 0 }}>
              Puedes escribir <strong>cualquier</strong> actividad; la app la recuerda
              para sugerírtela después. Cada actividad lleva su avance y cobertura por
              separado.
            </p>
            <div className="fila">
              <input
                type="number"
                min="1"
                max="8"
                value={nEquipos}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '') {
                    setNEquipos('');
                    return;
                  }
                  // Si se teclea encima de un número ya escrito (p. ej. "23"),
                  // vale el último dígito tecleado.
                  const n = parseInt(v.slice(-1), 10);
                  if (n >= 1 && n <= 8) setNEquipos(n);
                }}
              />
              <button
                className="boton primario"
                onClick={generarRutas}
                disabled={cargando || nEquipos === ''}
              >
                {cargando ? 'Calculando rutas…' : 'Generar rutas'}
              </button>
            </div>
            {cargando && (
              <div className="aviso">
                ⏳ Descargando las calles de OpenStreetMap… La primera vez puede
                tardar hasta un minuto si sus servidores están ocupados. Las
                siguientes veces es instantáneo.
              </div>
            )}
          </>
        )}

        {equipos && (
          <>
            <h2>3. Comparte la ruta a cada equipo</h2>
            <div className="fila">
              <button className="boton exito" onClick={compartirTodosWhatsApp}>
                📲 Enviar TODOS los links al grupo
              </button>
            </div>
            {equipos.map((eq, i) => (
              <div key={i} className="tarjeta-equipo" style={{ borderLeftColor: eq.color }}>
                <strong>Equipo {i + 1}</strong>
                <div className="datos">
                  {eq.km.toFixed(1)} km · {eq.ruta.length} tramos de calle
                  {vivEquipo(i) > 0 && <> · 🏠 ≈ {vivEquipo(i)} viviendas</>}
                </div>
                <div className="fila">
                  <button className="boton suave mini" onClick={() => copiarLink(i)}>
                    {copiado === i ? '✓ Copiado' : 'Copiar link'}
                  </button>
                  <button className="boton exito mini" onClick={() => compartirWhatsApp(i)}>
                    Enviar por WhatsApp
                  </button>
                </div>
              </div>
            ))}
            <div className="aviso">
              🏁 La bandera marca el punto de encuentro: todas las brigadas arrancan ahí y
              cada ruta empieza por las calles más cercanas. Cada brigadista abre su link
              en el teléfono: verá su ruta, su ubicación GPS y al terminar registrará el
              material repartido.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

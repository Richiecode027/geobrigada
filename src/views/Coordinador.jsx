import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap, marcadorInicio, marcadorEncuentro } from '../components/useMap.js';
import { buscarColonias, ringsPorClave } from '../lib/colonias.js';
import { obtenerCalles } from '../api/overpass.js';
import { buildUnits } from '../lib/units.js';
import { partition, orderRoute, puntoDeEncuentro, TEAM_COLORS } from '../lib/partition.js';
import { ringsBounds } from '../lib/geo.js';
import { linkEquipo } from '../lib/links.js';

export default function Coordinador() {
  const mapaRef = useRef(null);
  const map = useMap(mapaRef);

  const capaColonia = useRef(null);
  const capaEquipos = useRef(null);
  const capaDibujo = useRef(null);

  const [query, setQuery] = useState('');
  const [resultados, setResultados] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [colonia, setColonia] = useState(null);
  const [nEquipos, setNEquipos] = useState(2);
  const [equipos, setEquipos] = useState(null);
  const [encuentro, setEncuentro] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [dibujando, setDibujando] = useState(false);
  const [puntos, setPuntos] = useState([]);
  const [copiado, setCopiado] = useState(-1);

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

  async function elegirResultado(r) {
    setResultados(null);
    setEquipos(null);
    setAviso('');
    const rings = await ringsPorClave(r.k);
    if (rings) {
      setColonia({ nombre: r.n, clave: r.k, rings, tienePoligono: true });
    } else {
      setColonia(null);
      setAviso(
        `"${r.n}" está en el catálogo pero sin polígono disponible. ` +
          'Usa "Dibujar colonia a mano": toca el mapa siguiendo el contorno de la colonia y al final presiona "Terminar dibujo".'
      );
    }
  }

  // --- dibujo manual ----------------------------------------------------
  function iniciarDibujo() {
    setDibujando(true);
    setPuntos([]);
    setColonia(null);
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
    map.fitBounds(ringsBounds(colonia.rings), { padding: [20, 20] });
  }, [map, colonia]);

  // --- generar rutas ------------------------------------------------------
  async function generarRutas() {
    setError('');
    setCargando(true);
    setEquipos(null);
    try {
      const calles = await obtenerCalles(colonia.rings);
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
      eq.ruta.forEach((u) =>
        L.polyline(u.coords, { color: eq.color, weight: 4, opacity: 0.85 }).addTo(g)
      );
      marcadorInicio(eq.ruta[0].coords[0], i + 1, eq.color).addTo(g);
    });
    if (encuentro) marcadorEncuentro(encuentro).addTo(g);
    capaEquipos.current = g;
  }, [map, equipos]);

  // --- compartir ----------------------------------------------------------
  function link(i) {
    return linkEquipo({ colonia, nEquipos: equipos.length, equipo: i + 1 });
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

  function compartirWhatsApp(i) {
    const texto =
      `🗺️ GeoBrigada – ${colonia.nombre}\n` +
      `Eres el *Equipo ${i + 1}* de ${equipos.length}. ` +
      `Tu ruta mide ${equipos[i].km.toFixed(1)} km.\n` +
      `Ábrela aquí y activa tu GPS:\n${link(i)}`;
    window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank');
  }

  // --- render ---------------------------------------------------------------
  return (
    <div className="contenido">
      <div className="mapa" ref={mapaRef} />
      <div className="panel">
        <h2>1. Busca la colonia</h2>
        <form onSubmit={buscar} className="fila">
          <input
            type="text"
            placeholder="Ej. Colonia Ventura Puente"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, minWidth: '180px' }}
          />
          <button className="boton" disabled={buscando}>
            {buscando ? 'Buscando…' : 'Buscar'}
          </button>
        </form>

        {resultados &&
          resultados.map((r, i) => (
            <div key={i} className="resultado" onClick={() => elegirResultado(r)}>
              <strong>{r.n}</strong> · {r.t}
              {r.cp ? ` · CP ${r.cp}` : ''}
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
            <button className="boton peligro mini" onClick={() => { setDibujando(false); setPuntos([]); }}>
              Cancelar
            </button>
          </div>
        )}

        {aviso && <div className="aviso">{aviso}</div>}
        {error && <div className="error">{error}</div>}

        {colonia && (
          <>
            <h2>2. ¿Cuántos equipos hay hoy?</h2>
            <div className="fila">
              <strong style={{ flex: 1 }}>{colonia.nombre}</strong>
            </div>
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
          </>
        )}

        {equipos && (
          <>
            <h2>3. Comparte la ruta a cada equipo</h2>
            {equipos.map((eq, i) => (
              <div key={i} className="tarjeta-equipo" style={{ borderLeftColor: eq.color }}>
                <strong>Equipo {i + 1}</strong>
                <div className="datos">
                  {eq.km.toFixed(1)} km · {eq.ruta.length} tramos de calle
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

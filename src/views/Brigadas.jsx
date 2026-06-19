import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap } from '../components/useMap.js';
import { buscarColonias, ringsPorClave, todasLasColonias } from '../lib/colonias.js';
import { repartir, resumenBrigadas, vivColonia, capacidadDe } from '../lib/brigadas.js';
import { TEAM_COLORS } from '../lib/partition.js';
import { ringsBounds } from '../lib/geo.js';
import {
  cargarPlan,
  guardarPlan,
  cargarCampanas,
  recordarCampana,
  cargarActividades,
  recordarActividad
} from '../lib/storage.js';

let contador = 1;
const nuevoId = () => 'b' + Date.now().toString(36) + contador++;

const colorBrigada = (i) => TEAM_COLORS[i % TEAM_COLORS.length];

export default function Brigadas({ onPlanear }) {
  const mapaRef = useRef(null);
  const map = useMap(mapaRef);
  const capa = useRef(null);

  const plan = cargarPlan();
  const [campana, setCampana] = useState(plan?.campana || '');
  const [actividad, setActividad] = useState(plan?.actividad || '');
  const [brigadas, setBrigadas] = useState(
    plan?.brigadas || [
      { id: nuevoId(), nombre: 'Brigada 1', tipo: 'completo' },
      { id: nuevoId(), nombre: 'Brigada 2', tipo: 'completo' }
    ]
  );
  const [pool, setPool] = useState(plan?.pool || []);
  const [asignacion, setAsignacion] = useState(plan?.asignacion || {});

  const [query, setQuery] = useState('');
  const [resultados, setResultados] = useState(null);
  const [campanasG] = useState(cargarCampanas());
  const [actividadesG] = useState(cargarActividades());

  // Guarda el plan cada vez que cambia algo.
  useEffect(() => {
    guardarPlan({ campana, actividad, brigadas, pool, asignacion });
  }, [campana, actividad, brigadas, pool, asignacion]);

  // --- búsqueda de colonias para agregar al pool ---------------------------
  useEffect(() => {
    if (query.trim().length < 2) {
      setResultados(null);
      return;
    }
    const tid = setTimeout(async () => {
      const res = await buscarColonias(query);
      setResultados(res);
    }, 250);
    return () => clearTimeout(tid);
  }, [query]);

  function agregarColonia(r) {
    setQuery('');
    setResultados(null);
    if (pool.some((c) => c.k === r.k)) return; // ya está
    setPool((p) => [...p, { k: r.k, n: r.n, v: r.v || 0 }]);
  }

  function quitarColonia(k) {
    setPool((p) => p.filter((c) => c.k !== k));
    setAsignacion((a) => {
      const n = { ...a };
      delete n[k];
      return n;
    });
  }

  // Agrega TODAS las colonias del catálogo (para campañas de toda la ciudad).
  async function agregarTodas() {
    const todas = await todasLasColonias();
    setQuery('');
    setResultados(null);
    setPool(todas.map((c) => ({ k: c.k, n: c.n, v: c.v || 0 })));
  }

  // --- brigadas ------------------------------------------------------------
  function agregarBrigada() {
    setBrigadas((b) => [
      ...b,
      { id: nuevoId(), nombre: 'Brigada ' + (b.length + 1), tipo: 'completo' }
    ]);
  }

  function cambiarBrigada(id, campo, valor) {
    setBrigadas((b) => b.map((x) => (x.id === id ? { ...x, [campo]: valor } : x)));
  }

  function quitarBrigada(id) {
    setBrigadas((b) => b.filter((x) => x.id !== id));
    setAsignacion((a) => {
      const n = { ...a };
      for (const k in n) if (n[k] === id) delete n[k];
      return n;
    });
  }

  // --- repartir ------------------------------------------------------------
  function repartirAhora() {
    if (campana.trim()) recordarCampana(campana.trim());
    if (actividad.trim()) recordarActividad(actividad.trim());
    setAsignacion(repartir(brigadas, pool));
  }

  function reasignar(k, idBrigada) {
    setAsignacion((a) => ({ ...a, [k]: idBrigada }));
  }

  const repartido = Object.keys(asignacion).length > 0;
  const resumen = resumenBrigadas(brigadas, pool, asignacion);
  const idColor = {};
  brigadas.forEach((b, i) => (idColor[b.id] = colorBrigada(i)));

  // --- mapa: colonias coloreadas por brigada -------------------------------
  useEffect(() => {
    if (!map) return;
    if (capa.current) capa.current.remove();
    if (pool.length === 0) return;
    const g = L.layerGroup().addTo(map);
    const bounds = [];
    (async () => {
      for (const col of pool) {
        const rings = await ringsPorClave(col.k);
        if (!rings) continue;
        const id = asignacion[col.k];
        const color = id && idColor[id] ? idColor[id] : '#9aa5b1';
        rings.forEach((r) => {
          L.polygon(r, { color, weight: 2, fillColor: color, fillOpacity: 0.35 })
            .bindTooltip(`${col.n} · ${vivColonia(col)} viv.`)
            .addTo(g);
          bounds.push(...r);
        });
      }
      if (bounds.length) map.fitBounds(ringsBounds([bounds]), { padding: [25, 25] });
    })();
    capa.current = g;
  }, [map, pool, asignacion, brigadas]);

  const totalViv = pool.reduce((s, c) => s + vivColonia(c), 0);

  return (
    <div className="contenido">
      <div className="mapa" ref={mapaRef} />
      <div className="panel">
        <h2>Reparto de colonias entre brigadas</h2>

        <label className="etiqueta">Campaña</label>
        <input
          type="text"
          list="lista-campanas"
          value={campana}
          onChange={(e) => setCampana(e.target.value)}
        />
        <datalist id="lista-campanas">
          {campanasG.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>

        <label className="etiqueta">Actividad</label>
        <input
          type="text"
          list="lista-actividades-brig"
          value={actividad}
          onChange={(e) => setActividad(e.target.value)}
        />
        <datalist id="lista-actividades-brig">
          {actividadesG.map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>

        {/* --- brigadas --- */}
        <h3>Brigadas ({brigadas.length})</h3>
        {brigadas.map((b, i) => (
          <div key={b.id} className="fila" style={{ alignItems: 'center' }}>
            <span
              className="punto-color"
              style={{ background: colorBrigada(i) }}
              title="Color en el mapa"
            />
            <input
              type="text"
              value={b.nombre}
              onChange={(e) => cambiarBrigada(b.id, 'nombre', e.target.value)}
              style={{ flex: 1, minWidth: 90 }}
            />
            <select
              value={b.tipo}
              onChange={(e) => cambiarBrigada(b.id, 'tipo', e.target.value)}
              style={{ padding: 7, borderRadius: 8, border: '1px solid var(--borde)' }}
            >
              <option value="completo">Tiempo completo</option>
              <option value="medio">Medio tiempo</option>
            </select>
            <button
              className="boton peligro mini"
              onClick={() => quitarBrigada(b.id)}
              disabled={brigadas.length <= 1}
            >
              ✕
            </button>
          </div>
        ))}
        <button className="boton suave mini" onClick={agregarBrigada}>
          + Agregar brigada
        </button>

        {/* --- pool de colonias --- */}
        <h3>
          Colonias a repartir ({pool.length}
          {totalViv > 0 ? ` · ${totalViv} viviendas` : ''})
        </h3>
        <label className="etiqueta">Buscar colonia para agregar</label>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {resultados &&
          resultados.map((r) => (
            <div key={r.k} className="resultado" onClick={() => agregarColonia(r)}>
              <strong>{r.n}</strong> · {r.t}
              {r.v > 0 ? ` · 🏠 ${r.v}` : ''}
            </div>
          ))}
        <div className="fila" style={{ marginTop: 6 }}>
          <button className="boton suave mini" onClick={agregarTodas}>
            🏙️ Agregar todas las colonias
          </button>
        </div>

        {pool.length === 0 && (
          <div className="aviso">
            Agrega las colonias que esta actividad va a cubrir. Luego presiona
            “Repartir” y la app las distribuye entre las brigadas según sus viviendas
            y su jornada. Después puedes mover colonias a mano.
          </div>
        )}

        {pool.length > 0 && (
          <div className="fila" style={{ marginTop: 8 }}>
            <button className="boton primario" onClick={repartirAhora}>
              ⚖️ Repartir entre brigadas
            </button>
            <button
              className="boton suave mini"
              onClick={() => {
                setPool([]);
                setAsignacion({});
              }}
            >
              Vaciar
            </button>
          </div>
        )}

        {/* --- resultado por brigada --- */}
        {repartido &&
          resumen.map((b, i) => (
            <div
              key={b.id}
              className="tarjeta-equipo"
              style={{ borderLeftColor: colorBrigada(i), marginTop: 10 }}
            >
              <strong>{b.nombre}</strong>{' '}
              <span style={{ fontSize: '0.8rem', color: '#666' }}>
                ({b.tipo === 'medio' ? 'medio tiempo' : 'tiempo completo'})
              </span>
              <div className="datos">
                {b.colonias.length} colonia(s) · 🏠 {b.viviendas} viviendas · carga{' '}
                {Math.round(b.viviendas / b.cap)}
              </div>
              {b.colonias.map((c) => (
                <div key={c.k} className="fila-colonia">
                  <span style={{ flex: 1 }}>
                    {c.n}
                    <span style={{ color: '#888', fontSize: '0.78rem' }}>
                      {' '}
                      · {vivColonia(c)} viv.
                    </span>
                  </span>
                  <select
                    value={asignacion[c.k]}
                    onChange={(e) => reasignar(c.k, e.target.value)}
                    title="Mover a otra brigada"
                    style={{ fontSize: '0.78rem', borderRadius: 6, border: '1px solid var(--borde)' }}
                  >
                    {brigadas.map((br) => (
                      <option key={br.id} value={br.id}>
                        {br.nombre}
                      </option>
                    ))}
                  </select>
                  <button
                    className="boton exito mini"
                    onClick={() =>
                      onPlanear({
                        clave: c.k,
                        nombre: c.n,
                        campana: campana.trim(),
                        actividad: actividad.trim(),
                        brigada: b.nombre
                      })
                    }
                    title="Generar las rutas y links de esta colonia"
                  >
                    Planear ▸
                  </button>
                </div>
              ))}
              {b.colonias.length === 0 && (
                <div style={{ fontSize: '0.8rem', color: '#999' }}>
                  Sin colonias asignadas.
                </div>
              )}
            </div>
          ))}

        {repartido && (
          <div className="aviso" style={{ marginTop: 10 }}>
            Cada color es una brigada (lo ves en el mapa). Mueve una colonia con el
            selector si quieres ajustar el reparto. Toca <strong>“Planear ▸”</strong> en
            una colonia para generar sus rutas y los links de sus equipos.
          </div>
        )}
      </div>
    </div>
  );
}

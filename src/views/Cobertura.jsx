import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap } from '../components/useMap.js';
import { cargarReportes } from '../lib/storage.js';
import { nubeConfigurada, cargarReportesNube } from '../lib/nube.js';
import { ringsPorClave, coloniaPorClave } from '../lib/colonias.js';
import { obtenerCalles } from '../api/overpass.js';
import { buildUnits } from '../lib/units.js';
import { decodificarPoly } from '../lib/links.js';
import { ringsBounds, haversine } from '../lib/geo.js';

// Una cuadra cuenta como cubierta si un brigadista pasó a menos de esto.
const RADIO_CUBIERTO_M = 30;

function colorPorPct(pct) {
  if (pct >= 80) return '#2a9d3a'; // verde: bien cubierta
  if (pct >= 40) return '#e0a514'; // ámbar: a medias
  return '#d03333'; // rojo: apenas tocada
}

function agrupar(reportes) {
  const porColonia = new Map();
  for (const r of reportes) {
    const k = r.col || 'manual:' + (r.colonia || '?');
    let g = porColonia.get(k);
    if (!g) {
      g = {
        k,
        col: r.col || null,
        poly: r.poly || null,
        nombre: r.colonia || 'Colonia',
        visitas: 0,
        mejorPct: 0,
        entregados: 0,
        kmCubiertos: 0,
        ultimaFecha: r.fecha,
        tracks: []
      };
      porColonia.set(k, g);
    }
    g.visitas++;
    g.mejorPct = Math.max(g.mejorPct, r.porcentaje || 0);
    g.entregados +=
      r.entregados != null
        ? r.entregados
        : Object.values(r.materiales || {}).reduce((s, v) => s + v, 0);
    g.kmCubiertos += ((r.km || 0) * (r.porcentaje || 0)) / 100;
    if (r.fecha > g.ultimaFecha) g.ultimaFecha = r.fecha;
    if ((r.recorridoReal || []).length > 1) g.tracks.push(r.recorridoReal);
    if (!g.poly && r.poly) g.poly = r.poly;
  }
  return [...porColonia.values()].sort((a, b) =>
    b.ultimaFecha.localeCompare(a.ultimaFecha)
  );
}

export default function Cobertura() {
  const mapaRef = useRef(null);
  const map = useMap(mapaRef);
  const capaPoligonos = useRef(null);
  const capaDetalle = useRef(null);

  const [reportes, setReportes] = useState([]); // todos, nube + locales
  const [filtro, setFiltro] = useState(''); // '' = todas las actividades
  const [filtroCamp, setFiltroCamp] = useState(''); // '' = todas las campañas
  const [cargando, setCargando] = useState(true);
  const [detalle, setDetalle] = useState(null); // grupo seleccionado
  const [detalleInfo, setDetalleInfo] = useState('');
  const [calculando, setCalculando] = useState(false);
  const [error, setError] = useState('');
  const [viviendas, setViviendas] = useState({}); // clave de colonia -> viviendas

  // --- carga: reportes de la nube + locales ---------------------------------
  useEffect(() => {
    (async () => {
      let nube = [];
      try {
        nube = await cargarReportesNube();
      } catch {
        setError('No se pudo leer la nube; se muestra solo lo de este dispositivo.');
      }
      const locales = cargarReportes();
      const firma = (r) => `${r.fecha}|${r.equipo}|${r.colonia}`;
      const enNube = new Set(nube.map(firma));
      setReportes([...nube, ...locales.filter((r) => !enNube.has(firma(r)))]);
      setCargando(false);
    })();
  }, []);

  // Carga las viviendas (INEGI) de las colonias que aparecen en los reportes.
  useEffect(() => {
    const claves = [...new Set(reportes.map((r) => r.col).filter(Boolean))];
    (async () => {
      const m = {};
      for (const k of claves) {
        if (viviendas[k] != null) continue;
        const c = await coloniaPorClave(k);
        if (c) m[k] = c.v || 0;
      }
      if (Object.keys(m).length) setViviendas((prev) => ({ ...prev, ...m }));
    })();
  }, [reportes]);

  // Campañas y actividades distintas que existen (para los filtros).
  const campanas = useMemo(
    () => [...new Set(reportes.map((r) => r.campana).filter(Boolean))].sort(),
    [reportes]
  );
  const actividades = useMemo(
    () => [...new Set(reportes.map((r) => r.actividad || 'Reparto'))].sort(),
    [reportes]
  );

  // Agrupa por colonia, respetando los filtros de campaña y actividad.
  const grupos = useMemo(() => {
    const filtrados = reportes.filter(
      (r) =>
        (!filtroCamp || r.campana === filtroCamp) &&
        (!filtro || (r.actividad || 'Reparto') === filtro)
    );
    return agrupar(filtrados);
  }, [reportes, filtro, filtroCamp]);

  // Al cambiar un filtro se cierra el detalle (pertenece a otro conjunto).
  useEffect(() => {
    setDetalle(null);
  }, [filtro, filtroCamp]);

  // --- pinta los polígonos de las colonias visitadas ------------------------
  useEffect(() => {
    if (!map) return;
    if (capaPoligonos.current) capaPoligonos.current.remove();
    if (grupos.length === 0) return;
    const g = L.layerGroup().addTo(map);
    const bounds = [];
    (async () => {
      for (const grupo of grupos) {
        let rings = null;
        if (grupo.col) rings = await ringsPorClave(grupo.col);
        else if (grupo.poly) rings = [decodificarPoly(grupo.poly)];
        if (!rings) continue;
        grupo.rings = rings;
        const color = colorPorPct(grupo.mejorPct);
        rings.forEach((r) => {
          L.polygon(r, {
            color,
            weight: 2,
            fillColor: color,
            fillOpacity: 0.3
          })
            .bindTooltip(`${grupo.nombre} · ${grupo.mejorPct}%`)
            .on('click', () => setDetalle(grupo))
            .addTo(g);
          bounds.push(...r);
        });
      }
      if (bounds.length) map.fitBounds(ringsBounds([bounds]), { padding: [30, 30] });
    })();
    capaPoligonos.current = g;
  }, [map, grupos]);

  // --- detalle de una colonia: qué cuadras se cubrieron y cuáles faltan -----
  useEffect(() => {
    if (!map) return;
    if (capaDetalle.current) {
      capaDetalle.current.remove();
      capaDetalle.current = null;
    }
    setDetalleInfo('');
    if (!detalle) return;

    (async () => {
      setCalculando(true);
      try {
        let rings = detalle.rings;
        if (!rings && detalle.col) rings = await ringsPorClave(detalle.col);
        if (!rings && detalle.poly) rings = [decodificarPoly(detalle.poly)];
        if (!rings) throw new Error('Esta colonia no tiene polígono guardado.');

        const ways = await obtenerCalles(rings);
        const units = buildUnits(ways, rings);
        const puntosTrack = detalle.tracks.flat();

        const g = L.layerGroup().addTo(map);
        let metrosTotal = 0;
        let metrosCubiertos = 0;
        for (const u of units) {
          let dentro = 0;
          for (const c of u.coords) {
            for (const t of puntosTrack) {
              if (haversine(c, t) < RADIO_CUBIERTO_M) {
                dentro++;
                break;
              }
            }
          }
          const frac = u.coords.length ? dentro / u.coords.length : 0;
          metrosTotal += u.length;
          metrosCubiertos += u.length * frac;
          const cubierta = frac >= 0.6;
          L.polyline(u.coords, {
            color: cubierta ? '#2a9d3a' : '#d03333',
            weight: cubierta ? 5 : 3,
            opacity: cubierta ? 0.85 : 0.7,
            dashArray: cubierta ? null : '6 6'
          }).addTo(g);
        }
        capaDetalle.current = g;
        map.fitBounds(ringsBounds(rings), { padding: [25, 25] });

        const pctReal = metrosTotal ? Math.round((100 * metrosCubiertos) / metrosTotal) : 0;
        setDetalleInfo(
          `${detalle.nombre}${filtro ? ' (' + filtro + ')' : ''}: ${pctReal}% de sus ` +
            `calles cubiertas según el GPS (${(metrosCubiertos / 1000).toFixed(1)} de ` +
            `${(metrosTotal / 1000).toFixed(1)} km). ` +
            'Verde = ya repartido · rojo punteado = falta.'
        );
      } catch (e) {
        setDetalleInfo('No se pudo calcular el detalle: ' + e.message);
      }
      setCalculando(false);
    })();
  }, [map, detalle]);

  // --- totales ---------------------------------------------------------------
  const totalVisitas = grupos.reduce((s, g) => s + g.visitas, 0);
  const totalEntregado = grupos.reduce((s, g) => s + g.entregados, 0);
  const totalKm = grupos.reduce((s, g) => s + g.kmCubiertos, 0);

  return (
    <div className="contenido">
      <div className="mapa" ref={mapaRef} />
      <div className="panel">
        <h2>Cobertura de la campaña</h2>

        {error && <div className="aviso">{error}</div>}
        {cargando && <p>Cargando recorridos…</p>}

        {!cargando && reportes.length === 0 && (
          <div className="aviso">
            Todavía no hay recorridos guardados. Cuando las brigadas empiecen a
            reportar, aquí se pinta el mapa de lo cubierto y lo que falta.
          </div>
        )}

        {!cargando && reportes.length > 0 && (
          <>
            {campanas.length > 0 && (
              <div className="fila">
                <label style={{ fontSize: '0.88rem' }}>Campaña:</label>
                <select
                  value={filtroCamp}
                  onChange={(e) => setFiltroCamp(e.target.value)}
                  style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid var(--borde)' }}
                >
                  <option value="">Todas las campañas</option>
                  {campanas.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {actividades.length > 1 && (
              <div className="fila">
                <label style={{ fontSize: '0.88rem' }}>Actividad:</label>
                <select
                  value={filtro}
                  onChange={(e) => setFiltro(e.target.value)}
                  style={{ flex: 1, padding: '8px', borderRadius: 8, border: '1px solid var(--borde)' }}
                >
                  <option value="">Todas las actividades</option>
                  {actividades.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <p style={{ fontSize: '0.9rem' }}>
              <strong>{grupos.length}</strong> colonia(s) ·{' '}
              <strong>{totalVisitas}</strong> recorridos ·{' '}
              <strong>{totalKm.toFixed(1)}</strong> km cubiertos ·{' '}
              <strong>{totalEntregado}</strong> objetos entregados
              {filtro ? ` · actividad: ${filtro}` : ''}
            </p>

            {calculando && <div className="aviso">⏳ Calculando cuadra por cuadra…</div>}
            {detalleInfo && <div className="aviso">{detalleInfo}</div>}
            {detalle && !calculando && (
              <div className="fila">
                <button className="boton suave mini" onClick={() => setDetalle(null)}>
                  ← Volver al mapa general
                </button>
              </div>
            )}

            {grupos.map((g) => (
              <div
                key={g.k}
                className="resultado"
                onClick={() => setDetalle(g)}
                style={{ borderLeftWidth: 6, borderLeftColor: colorPorPct(g.mejorPct) }}
              >
                <strong>{g.nombre}</strong>{' '}
                <span style={{ color: colorPorPct(g.mejorPct), fontWeight: 700 }}>
                  {g.mejorPct}%
                </span>
                <div style={{ fontSize: '0.8rem', color: '#666' }}>
                  {g.visitas} recorrido(s) · {g.entregados} entregados · última:{' '}
                  {new Date(g.ultimaFecha).toLocaleDateString('es-MX')}
                </div>
                {viviendas[g.k] > 0 && (
                  <div style={{ fontSize: '0.8rem', marginTop: 2 }}>
                    🏠 {viviendas[g.k]} viviendas
                    {filtro && g.entregados < viviendas[g.k] ? (
                      <strong style={{ color: '#c1121f' }}>
                        {' '}· faltan ~{viviendas[g.k] - g.entregados}
                      </strong>
                    ) : filtro ? (
                      <strong style={{ color: '#2a9d3a' }}> · completa ✓</strong>
                    ) : null}
                  </div>
                )}
              </div>
            ))}

            <div className="aviso">
              El color de cada colonia es el mejor porcentaje logrado ahí
              {filtro ? ` en "${filtro}"` : ' (todas las actividades juntas)'}. Toca
              una colonia para ver cuadra por cuadra qué se cubrió y qué falta.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

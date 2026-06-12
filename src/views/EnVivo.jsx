import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap, marcadorInicio } from '../components/useMap.js';
import { TEAM_COLORS } from '../lib/partition.js';
import { nubeConfigurada, cargarPosiciones } from '../lib/nube.js';

const REFRESCO_MS = 20000; // cada cuánto se piden posiciones nuevas
const VENTANA_MIN = 30; // solo se muestran equipos vistos en la última media hora

function haceCuanto(iso) {
  const seg = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seg < 60) return `hace ${seg} s`;
  const min = Math.round(seg / 60);
  return `hace ${min} min`;
}

export default function EnVivo() {
  const mapaRef = useRef(null);
  const map = useMap(mapaRef);
  const capa = useRef(null);
  const encuadrado = useRef(false);

  const [posiciones, setPosiciones] = useState([]);
  const [error, setError] = useState('');
  const [cargado, setCargado] = useState(false);

  // Pide las posiciones al abrir y luego cada 20 segundos.
  useEffect(() => {
    if (!nubeConfigurada()) return;
    let activo = true;
    async function tick() {
      try {
        const p = await cargarPosiciones(VENTANA_MIN);
        if (activo) {
          setPosiciones(p);
          setError('');
          setCargado(true);
        }
      } catch (e) {
        if (activo) {
          setError('No se pudieron leer las posiciones (' + e.message + ').');
          setCargado(true);
        }
      }
    }
    tick();
    const tid = setInterval(tick, REFRESCO_MS);
    return () => {
      activo = false;
      clearInterval(tid);
    };
  }, []);

  // Dibuja un marcador numerado por equipo.
  useEffect(() => {
    if (!map) return;
    if (capa.current) capa.current.remove();
    if (posiciones.length === 0) return;
    const g = L.layerGroup().addTo(map);
    for (const p of posiciones) {
      const color = TEAM_COLORS[((p.equipo || 1) - 1) % TEAM_COLORS.length];
      marcadorInicio([p.lat, p.lng], p.equipo, color)
        .bindTooltip(
          `Equipo ${p.equipo} · ${p.colonia || ''}${p.actividad ? ' · ' + p.actividad : ''}` +
            ` · ${p.pct ?? 0}% · ${haceCuanto(p.actualizado)}`
        )
        .addTo(g);
    }
    capa.current = g;
    // Encuadra solo la primera vez, para no pelear con el zoom del coordinador.
    if (!encuadrado.current) {
      const lats = posiciones.map((p) => p.lat);
      const lngs = posiciones.map((p) => p.lng);
      map.fitBounds(
        [
          [Math.min(...lats), Math.min(...lngs)],
          [Math.max(...lats), Math.max(...lngs)]
        ],
        { padding: [40, 40], maxZoom: 16 }
      );
      encuadrado.current = true;
    }
  }, [map, posiciones]);

  return (
    <div className="contenido">
      <div className="mapa" ref={mapaRef} />
      <div className="panel">
        <h2>Equipos en vivo</h2>

        {!nubeConfigurada() && (
          <div className="aviso">La nube no está configurada en esta versión.</div>
        )}
        {error && <div className="error">{error}</div>}

        {cargado && posiciones.length === 0 && !error && (
          <div className="aviso">
            Nadie está transmitiendo ahora. Las posiciones aparecen solas cuando un
            brigadista activa su GPS (se actualizan cada ~25 segundos y aquí se
            refrescan cada 20).
          </div>
        )}

        {posiciones.map((p) => {
          const color = TEAM_COLORS[((p.equipo || 1) - 1) % TEAM_COLORS.length];
          return (
            <div key={p.id} className="tarjeta-equipo" style={{ borderLeftColor: color }}>
              <strong>Equipo {p.equipo}</strong>
              {p.colonia ? ` · ${p.colonia}` : ''}
              {p.actividad ? ` · ${p.actividad}` : ''}
              <div className="datos">
                Ruta recorrida: {p.pct ?? 0}% · visto {haceCuanto(p.actualizado)}
              </div>
              <div className="fila">
                <button
                  className="boton suave mini"
                  onClick={() => map && map.setView([p.lat, p.lng], 17)}
                >
                  📍 Centrar
                </button>
              </div>
            </div>
          );
        })}

        {posiciones.length > 0 && (
          <div className="aviso">
            Cada marcador es la última posición reportada por ese equipo. Si un
            equipo deja de moverse más de {VENTANA_MIN} minutos, desaparece de la
            lista.
          </div>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import L from 'leaflet';
import 'leaflet-rotate';
import { haversine } from '../lib/geo.js';

// Centro de Morelia (Catedral)
const MORELIA = [19.7036, -101.1928];

export function useMap(containerRef, opciones = {}) {
  const [map, setMap] = useState(null);
  const rotar = !!opciones.rotar;
  useEffect(() => {
    // `rotate` (plugin leaflet-rotate) solo se activa para la vista guiada del
    // brigadista; las demás vistas siguen con el norte siempre arriba.
    const m = L.map(containerRef.current, {
      zoomControl: true,
      rotate: rotar,
      rotateControl: false,
      touchRotate: false,
      shiftKeyRotate: false,
      bearing: 0
    }).setView(MORELIA, 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19
    }).addTo(m);
    setMap(m);
    return () => m.remove();
  }, []);
  return map;
}

// Marcador numerado para el inicio de la ruta de cada equipo.
export function marcadorInicio(latlng, numero, color) {
  return L.marker(latlng, {
    icon: L.divIcon({
      className: 'inicio-equipo',
      html: `<div style="background:${color}">${numero}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    })
  });
}

// Bandera del punto de encuentro donde arrancan todas las brigadas.
export function marcadorEncuentro(latlng) {
  return L.marker(latlng, {
    icon: L.divIcon({
      className: 'punto-encuentro',
      html: '<div>🏁</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    }),
    zIndexOffset: 1000
  });
}

// Pastilla "Fin" en el último punto del recorrido: ahí termina de repartir.
export function marcadorFin(latlng) {
  return L.marker(latlng, {
    icon: L.divIcon({
      className: 'fin-ruta',
      html: '<div>Fin</div>',
      iconSize: [34, 20],
      iconAnchor: [17, 10]
    }),
    zIndexOffset: 900
  });
}

// Rumbo (0 = norte, sentido horario) de a hacia b, para girar la flecha.
function rumbo(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x =
    Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
    Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// Flechas de sentido a lo largo del recorrido (una cada ~`cadaMetros`), para
// que el brigadista sepa hacia dónde caminar. Devuelve una capa lista para
// agregar al mapa.
export function flechasDeRecorrido(latlngs, color, cadaMetros = 130) {
  const grupo = L.layerGroup();
  if (!latlngs || latlngs.length < 2) return grupo;
  let acum = 0;
  let objetivo = cadaMetros / 2; // la primera flecha, a media distancia
  for (let i = 1; i < latlngs.length; i++) {
    const a = latlngs[i - 1];
    const b = latlngs[i];
    const d = haversine(a, b);
    if (d < 1e-6) continue;
    const ang = rumbo(a, b);
    while (acum + d >= objetivo) {
      const t = (objetivo - acum) / d;
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      grupo.addLayer(
        L.marker(p, {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: 'flecha-ruta',
            html: `<div style="transform:rotate(${ang}deg);color:${color}">▲</div>`,
            iconSize: [16, 16],
            iconAnchor: [8, 8]
          })
        })
      );
      objetivo += cadaMetros;
    }
    acum += d;
  }
  return grupo;
}

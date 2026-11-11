import { useEffect, useState } from 'react';
import L from 'leaflet';
import 'leaflet-rotate';

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

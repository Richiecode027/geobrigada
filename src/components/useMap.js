import { useEffect, useState } from 'react';
import L from 'leaflet';

// Centro de Morelia (Catedral)
const MORELIA = [19.7036, -101.1928];

export function useMap(containerRef) {
  const [map, setMap] = useState(null);
  useEffect(() => {
    const m = L.map(containerRef.current, { zoomControl: true }).setView(MORELIA, 13);
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

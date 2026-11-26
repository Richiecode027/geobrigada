// Dibuja en el mapa los límites de los distritos electorales LOCALES (trazo
// oficial del INE, src/lib/distritos.js) cuando `ver` es true. Lo usan Bardas
// y Planear con su botón "🗺️ Ver distritos". Va por debajo de todo y sin
// relleno fuerte: es referencia, no el asunto principal (los pines y rutas
// tienen que seguir resaltando).

import { useEffect } from 'react';
import L from 'leaflet';
import { cargarDistritos, COLOR_DISTRITO } from '../lib/distritos.js';

export default function useCapaDistritos(map, ver) {
  useEffect(() => {
    if (!map || !ver) return;
    let vivo = true;
    let capa = null;
    cargarDistritos()
      .then(({ distritos }) => {
        if (!vivo || !map) return;
        const g = L.layerGroup().addTo(map);
        for (const z of distritos) {
          const color = COLOR_DISTRITO[z.d] || '#888';
          L.polygon(z.rings, {
            color,
            weight: 2,
            opacity: 0.85,
            fillColor: color,
            fillOpacity: 0.06,
            dashArray: '5 4',
            interactive: false
          }).addTo(g);
          // El número, en el punto más ancho de la parte más grande.
          const mayor = z.rings.reduce((a, b) => (b.length > a.length ? b : a), z.rings[0]);
          const centro = L.polygon(mayor).getBounds().getCenter();
          L.marker(centro, {
            interactive: false,
            icon: L.divIcon({
              className: 'etiqueta-distrito',
              html: `<div style="border-color:${color};color:${color}">D${z.d}</div>`,
              iconSize: [40, 20],
              iconAnchor: [20, 10]
            })
          }).addTo(g);
        }
        g.eachLayer((c) => c.bringToBack?.());
        capa = g;
      })
      .catch(() => {
        /* sin catálogo de distritos el mapa funciona igual */
      });
    return () => {
      vivo = false;
      if (capa) capa.remove();
    };
  }, [map, ver]);
}

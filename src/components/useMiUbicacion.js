// "Aquí estás tú" en cualquier mapa de la app: UN solo marcador para todas las
// vistas (antes Bardas tenía flecha y las demás un punto azul, o nada).
//
// - Es una FLECHA que apunta hacia donde mira el teléfono (brújula). Si el
//   aparato no tiene brújula —o el navegador no la da— apunta hacia donde vas
//   CAMINANDO (sale de comparar las últimas lecturas del GPS). Mientras no hay
//   ni lo uno ni lo otro (recién abierta, parado, en una laptop) se ve el
//   punto azul de siempre.
// - Aparece SOLA, sin botón: si la vista no le pasa una posición, este mismo
//   hook prende el GPS en "modo ligero" (sin notificación permanente).
// - No se queda con los toques (interactive:false + pointer-events:none en
//   CSS): parado junto a una barda o a un equipo, el dedo tiene que llegar al
//   pin de abajo, no a la flecha.
// - Si el mapa está girado (vista guiada del brigadista, leaflet-rotate), la
//   flecha descuenta ese giro para seguir apuntando al lugar correcto.
//
// Uso:
//   useMiUbicacion(map)                         → GPS propio (vistas sin GPS)
//   useMiUbicacion(map, { posicion, precision }) → la vista ya trae su GPS
//   useMiUbicacion(map, { gpsPropio: false })    → la vista le pasa cada
//                                                  lectura con actualizar()
// Devuelve { centrar(zoom), actualizar([lat,lng], precision) }; centrar
// devuelve false si aún no hay lectura.
//
// Para que los cambios de rumbo (varias veces por segundo) no hagan
// re-renderizar la vista entera, todo vive en refs y se dibuja directo en
// Leaflet, sin estado de React.

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { iniciarGPS } from '../lib/gps.js';
import { seguirBrujula, pedirPermisoBrujula } from '../lib/brujula.js';
import { haversine } from '../lib/geo.js';

// Metros que hay que avanzar para estimar hacia dónde caminas: menos que esto
// es ruido del GPS (estando parado, la lectura "brinca" varios metros).
const METROS_PARA_RUMBO = 8;
// Lecturas con un margen de error mayor a esto no se usan para el rumbo.
const PRECISION_MAX_RUMBO = 30;

const HTML_FLECHA =
  '<div class="flecha-yo-giro">' +
  '<svg viewBox="0 0 36 36" width="36" height="36">' +
  '<circle cx="18" cy="18" r="11" fill="#1d6fd1" fill-opacity="0.22"/>' +
  '<path d="M18 4 L26 25 L18 20 L10 25 Z" fill="#1d6fd1" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>' +
  '</svg></div>';
const HTML_PUNTO = '<div class="punto-yo"></div>';

const icono = (flecha) =>
  L.divIcon({
    className: 'flecha-yo',
    html: flecha ? HTML_FLECHA : HTML_PUNTO,
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });

function rumboEntre(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const y = Math.sin(r(b[1] - a[1])) * Math.cos(r(b[0]));
  const x =
    Math.cos(r(a[0])) * Math.sin(r(b[0])) -
    Math.sin(r(a[0])) * Math.cos(r(b[0])) * Math.cos(r(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function useMiUbicacion(map, opciones = {}) {
  const controlada = 'posicion' in opciones || opciones.gpsPropio === false;
  const pos = useRef(null);
  const precision = useRef(null);
  const brujula = useRef(null);
  const marcha = useRef(null);
  const ancla = useRef(null);
  const capa = useRef(null);
  const dibujarRef = useRef(() => {});

  // --- dibujar (siempre la versión más reciente de map) ---------------------
  dibujarRef.current = () => {
    // getPane() es undefined en un mapa ya destruido (al cambiar de pestaña,
    // o cuando Vite recarga la vista en caliente): ahí no hay nada que dibujar.
    if (!map || !map.getPane('overlayPane') || !pos.current) return;
    if (!capa.current) {
      const circulo = L.circle(pos.current, {
        radius: 1, color: '#1d6fd1', weight: 1, fillOpacity: 0.08, interactive: false
      });
      const marcador = L.marker(pos.current, {
        icon: icono(false), interactive: false, keyboard: false, zIndexOffset: 1000
      });
      marcador._esFlecha = false;
      capa.current = { grupo: L.layerGroup([circulo, marcador]).addTo(map), circulo, marcador };
    }
    const { circulo, marcador } = capa.current;
    circulo.setLatLng(pos.current);
    // El círculo de error solo estorba si es enorme o diminuto.
    const m = precision.current;
    circulo.setRadius(m && m > 12 && m < 500 ? m : 0);
    marcador.setLatLng(pos.current);

    const rumbo = brujula.current ?? marcha.current;
    const flecha = rumbo != null;
    if (flecha !== marcador._esFlecha) {
      marcador.setIcon(icono(flecha));
      marcador._esFlecha = flecha;
    }
    if (flecha) {
      // En mapas que no giran, leaflet-rotate devuelve NaN (no 0): sin el
      // "|| 0" la flecha recibía rotate(NaNdeg) y se quedaba sin orientar.
      const giroMapa = Number(map.getBearing?.()) || 0;
      // Siempre por el camino corto: de 359° a 1° son 2°, no una vuelta
      // completa (con la transición de CSS se vería girar como trompo).
      let angulo = rumbo + giroMapa;
      if (marcador._angulo != null) {
        angulo = marcador._angulo + ((((angulo - marcador._angulo) % 360) + 540) % 360) - 180;
      }
      marcador._angulo = angulo;
      const div = marcador.getElement()?.querySelector('.flecha-yo-giro');
      if (div) div.style.transform = `rotate(${angulo}deg)`;
    }
  };
  // El marcador es un extra: si algo falla al dibujarlo, que no tumbe la vista.
  const dibujar = () => {
    try {
      dibujarRef.current();
    } catch (e) {
      console.warn('No se pudo dibujar tu ubicación:', e);
    }
  };

  function nuevaLectura(p, metros) {
    pos.current = p;
    precision.current = metros ?? null;
    if (!ancla.current) ancla.current = p;
    else if ((metros ?? 0) <= PRECISION_MAX_RUMBO && haversine(ancla.current, p) >= METROS_PARA_RUMBO) {
      marcha.current = rumboEntre(ancla.current, p);
      ancla.current = p;
    }
    dibujar();
  }

  // --- posición: la que da la vista, o GPS propio ----------------------------
  const posExterna = opciones.posicion;
  const precisionExterna = opciones.precision;
  useEffect(() => {
    if ('posicion' in opciones && posExterna) nuevaLectura(posExterna, precisionExterna);
  }, [controlada, posExterna && posExterna[0], posExterna && posExterna[1], precisionExterna]);

  useEffect(() => {
    if (controlada) return;
    // Errores en silencio: en estas vistas tu ubicación es un extra, no un
    // requisito, y no vale la pena llenar la pantalla de avisos por eso.
    return iniciarGPS('ubicacion', (p) => nuevaLectura([p.lat, p.lng], p.precision), () => {}, {
      segundoPlano: false
    });
  }, [controlada]);

  // --- brújula ---------------------------------------------------------------
  useEffect(() => {
    let vivo = true;
    let dejar = () => {};
    let quitarToque = () => {};
    const arrancar = () => {
      dejar();
      dejar = seguirBrujula((g) => {
        brujula.current = g;
        dibujar();
      });
    };
    pedirPermisoBrujula().then((ok) => {
      if (!vivo) return;
      if (ok) return arrancar();
      // iPhone: el permiso solo se puede pedir dentro de un toque del usuario.
      // Se reintenta en el primer toque a la pantalla.
      if (typeof window.DeviceOrientationEvent?.requestPermission !== 'function') return;
      const alTocar = () => {
        quitarToque();
        pedirPermisoBrujula().then((ok2) => vivo && ok2 && arrancar());
      };
      document.addEventListener('click', alTocar, true);
      quitarToque = () => document.removeEventListener('click', alTocar, true);
    });
    return () => {
      vivo = false;
      dejar();
      quitarToque();
    };
  }, []);

  // --- el mapa: redibujar al girarlo, limpiar al salir ------------------------
  useEffect(() => {
    if (!map) return;
    dibujar();
    map.on('rotate', dibujar);
    return () => {
      map.off('rotate', dibujar);
      if (capa.current) {
        try {
          capa.current.grupo.remove();
        } catch {
          /* el mapa ya se destruyó y se llevó la capa con él */
        }
        capa.current = null;
      }
    };
  }, [map]);

  return {
    // Para vistas que guardan su GPS en refs (sin estado de React) y no
    // quieren re-renderizar en cada lectura: le pasan cada punto a mano.
    actualizar: nuevaLectura,
    centrar(zoom = 16) {
      if (!map || !pos.current) return false;
      map.setView(pos.current, zoom);
      return true;
    }
  };
}

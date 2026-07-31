// Hacia dónde está mirando el teléfono, en grados (0 = norte, 90 = este).
//
// Sirve para que la flechita del mapa apunte al frente del celular: caminando
// en una colonia que no conoces, saber "hacia dónde voy" vale más que saber
// dónde estás parado.
//
// De dónde sale el dato, en orden de preferencia:
//  1. webkitCompassHeading — iOS ya lo da respecto al norte real.
//  2. deviceorientationabsolute (Android/Chrome) — alpha se cuenta al revés,
//     por eso va 360 - alpha.
//  3. deviceorientation con absolute = true.
// Si nada de eso existe (una laptop sin brújula), no se llama al callback y
// quien lo use simplemente pinta un punto en vez de una flecha.

// Android reporta la orientación respecto a la pantalla; si el teléfono está
// acostado hay que descontar cuánto giró la pantalla.
function giroDePantalla() {
  const a = window.screen?.orientation?.angle;
  return typeof a === 'number' ? a : window.orientation || 0;
}

export function seguirBrujula(alCambiar) {
  if (typeof window === 'undefined' || !window.DeviceOrientationEvent) return () => {};

  let ultimo = null;

  const manejar = (e) => {
    let grados = null;
    if (typeof e.webkitCompassHeading === 'number') {
      grados = e.webkitCompassHeading; // iOS: ya es respecto al norte
    } else if (typeof e.alpha === 'number' && (e.absolute || e.type === 'deviceorientationabsolute')) {
      grados = 360 - e.alpha;
    }
    if (grados == null || Number.isNaN(grados)) return;

    grados = (grados + giroDePantalla()) % 360;
    if (grados < 0) grados += 360;

    // La brújula tiembla: se ignoran los cambios chiquitos para que la flecha
    // no ande vibrando en la pantalla.
    if (ultimo != null) {
      let dif = Math.abs(grados - ultimo);
      if (dif > 180) dif = 360 - dif;
      if (dif < 2) return;
    }
    ultimo = grados;
    alCambiar(grados);
  };

  const eventos = ['deviceorientationabsolute', 'deviceorientation'];
  for (const ev of eventos) window.addEventListener(ev, manejar, true);
  return () => {
    for (const ev of eventos) window.removeEventListener(ev, manejar, true);
  };
}

// iOS 13+ exige pedir permiso, y solo dentro de un gesto del usuario (un
// toque). Devuelve true si se puede usar la brújula.
export async function pedirPermisoBrujula() {
  const DOE = window.DeviceOrientationEvent;
  if (!DOE) return false;
  if (typeof DOE.requestPermission !== 'function') return true; // Android: no lo pide
  try {
    return (await DOE.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

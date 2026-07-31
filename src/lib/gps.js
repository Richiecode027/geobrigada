// Fuente única de GPS de la app.
// - En el navegador: navigator.geolocation.watchPosition, como siempre.
// - Dentro del APK (Capacitor): @capgo/background-geolocation, en "modo de
//   entrega nativa": además de avisarle a esta pantalla, el propio Android
//   manda cada punto directo a netlify/functions/gps-relay (sin pasar por
//   el JavaScript de la app), así que el rastro sigue llegando aunque el
//   brigadista cierre la app o la quite de Recientes a medio camino. Ver
//   scripts/esquema-supabase.sql (tabla rastro_nativo) y el "relleno" al
//   reabrir en Brigadista.jsx.
// La vista no nota la diferencia: recibe los mismos puntos de cualquier fuente.

import { Capacitor, registerPlugin } from '@capacitor/core';

// true cuando la app corre dentro del APK Android (no en el navegador)
export const esApk = Capacitor.isNativePlatform();

const BackgroundGeolocation = esApk ? registerPlugin('BackgroundGeolocation') : null;

// Dentro del APK la app carga su código empaquetado desde una dirección
// interna del teléfono, así que la URL de entrega nativa debe apuntar
// siempre al sitio real (igual que los links de brigadista, ver links.js).
const URL_RELAY = 'https://geobrigada.netlify.app/.netlify/functions/gps-relay';

// Android 13+ pide permiso aparte para mostrar notificaciones; sin él no se ve
// el aviso "GeoBrigada sigue tu recorrido" con la pantalla apagada (el GPS
// funciona igual, pero el brigadista no sabría que sigue activo).
async function pedirPermisoNotificaciones() {
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    const estado = await LocalNotifications.checkPermissions();
    if (estado.display !== 'granted') await LocalNotifications.requestPermissions();
  } catch {
    /* si falla solo se pierde la notificación, no el rastreo */
  }
}

// Empieza a seguir la ubicación y devuelve una función para detener.
// claveRuta identifica la ruta (se usa para el rastro nativo; se ignora en
// el navegador). alPunto recibe { lat, lng, precision } (precision en
// metros); alError recibe un mensaje listo para mostrarse.
//
// segundoPlano = false es el "modo ligero": solo mientras la app está a la
// vista, sin notificación permanente ni entrega nativa. Se usa para enseñar
// dónde está parado el brigadista aunque no traiga recorrido — ahí sería
// abusivo dejarle prendido el aviso de "GeoBrigada sigue tu recorrido".
export function iniciarGPS(claveRuta, alPunto, alError, { segundoPlano = true } = {}) {
  if (!esApk) {
    if (!('geolocation' in navigator)) {
      alError('Este navegador no tiene GPS disponible.');
      return () => {};
    }
    const id = navigator.geolocation.watchPosition(
      (pos) =>
        alPunto({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          precision: pos.coords.accuracy
        }),
      (err) =>
        alError(
          'No se pudo obtener tu ubicación. Revisa permisos de ubicación del navegador. (' +
            err.message +
            ')'
        ),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }

  // --- APK: plugin de segundo plano ---------------------------------------
  let detenido = false;

  // Sin backgroundMessage el plugin NO se queda corriendo con la app cerrada:
  // eso es justo lo que se quiere en el modo ligero.
  const ajustes = segundoPlano
    ? {
        backgroundTitle: 'GeoBrigada sigue tu recorrido',
        backgroundMessage: 'Registrando tu ruta aunque cierres la app.',
        // entrega nativa: sigue mandando puntos aunque maten el proceso
        url: URL_RELAY + '?ruta=' + encodeURIComponent(claveRuta)
      }
    : {};

  const preparar = segundoPlano ? pedirPermisoNotificaciones() : Promise.resolve();

  preparar.finally(() => {
    if (detenido) return;
    BackgroundGeolocation.start(
      {
        ...ajustes,
        requestPermissions: true,
        stale: false,
        // mínimo de metros entre puntos; el track ya filtra a ~15 m aparte
        distanceFilter: 3
      },
      (pos, error) => {
        if (error) {
          if (error.code === 'NOT_AUTHORIZED') {
            alError('La app no tiene permiso de ubicación.');
            if (
              window.confirm(
                'GeoBrigada necesita tu ubicación para registrar el recorrido, ' +
                  'pero no tiene permiso.\n\n¿Abrir los ajustes de la app ahora?'
              )
            ) {
              BackgroundGeolocation.openSettings();
            }
          } else {
            alError(
              'No se pudo obtener tu ubicación. (' + (error.message || error.code) + ')'
            );
          }
          return;
        }
        alPunto({
          lat: pos.latitude,
          lng: pos.longitude,
          precision: pos.accuracy ?? 15
        });
      }
    );
  });

  return () => {
    detenido = true;
    BackgroundGeolocation.stop();
  };
}

// Una sola lectura de ubicación (no un seguimiento continuo): para cuando solo
// hace falta saber "dónde estoy parado ahora" una vez, como al agregar una
// barda nueva. Reutiliza iniciarGPS y se detiene en cuanto llega el primer
// punto, así funciona igual en el navegador y dentro del APK.
export function obtenerPosicionActual(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let listo = false;
    let detener = () => {};
    const vencido = setTimeout(() => {
      if (listo) return;
      listo = true;
      detener();
      reject(new Error('No se pudo obtener tu ubicación a tiempo.'));
    }, timeoutMs);
    detener = iniciarGPS(
      'una_vez',
      (p) => {
        if (listo) return;
        listo = true;
        clearTimeout(vencido);
        detener();
        resolve(p);
      },
      (msg) => {
        if (listo) return;
        listo = true;
        clearTimeout(vencido);
        detener();
        reject(new Error(msg));
      }
    );
  });
}

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
export function iniciarGPS(claveRuta, alPunto, alError) {
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

  pedirPermisoNotificaciones().finally(() => {
    if (detenido) return;
    BackgroundGeolocation.start(
      {
        backgroundTitle: 'GeoBrigada sigue tu recorrido',
        backgroundMessage: 'Registrando tu ruta aunque cierres la app.',
        requestPermissions: true,
        stale: false,
        // mínimo de metros entre puntos; el track ya filtra a ~15 m aparte
        distanceFilter: 3,
        // entrega nativa: sigue mandando puntos aunque maten el proceso
        url: URL_RELAY + '?ruta=' + encodeURIComponent(claveRuta)
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

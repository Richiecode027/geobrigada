// Fuente única de GPS de la app.
// - En el navegador: navigator.geolocation.watchPosition, como siempre.
// - Dentro del APK (Capacitor): plugin de geolocalización en segundo plano,
//   que sigue registrando aunque la pantalla esté apagada o se cambie de app,
//   mostrando la notificación persistente que exige Android.
// La vista no nota la diferencia: recibe los mismos puntos de cualquier fuente.

import { Capacitor, registerPlugin } from '@capacitor/core';

// true cuando la app corre dentro del APK Android (no en el navegador)
export const esApk = Capacitor.isNativePlatform();

const BackgroundGeolocation = esApk ? registerPlugin('BackgroundGeolocation') : null;

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
// alPunto recibe { lat, lng, precision } (precision en metros);
// alError recibe un mensaje listo para mostrarse.
export function iniciarGPS(alPunto, alError) {
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
  let idWatcher = null;
  let detenido = false;

  pedirPermisoNotificaciones().finally(() => {
    if (detenido) return;
    BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: 'GeoBrigada sigue tu recorrido',
        backgroundMessage: 'Registrando tu ruta aunque la pantalla esté apagada.',
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
    ).then((id) => {
      idWatcher = id;
      // si detuvieron el GPS antes de que el plugin terminara de arrancar
      if (detenido) BackgroundGeolocation.removeWatcher({ id });
    });
  });

  return () => {
    detenido = true;
    if (idWatcher !== null) {
      BackgroundGeolocation.removeWatcher({ id: idWatcher });
      idWatcher = null;
    }
  };
}

// Botón "atrás" de Android (el triángulo / el gesto de deslizar).
//
// Por defecto, dentro del APK ese botón CIERRA la app. A media jornada eso es
// pésimo: el brigadista pierde de vista su ruta por un toque accidental. Aquí
// se registra qué debe pasar en cada pantalla: cerrar el formulario abierto,
// salir del recorrido y volver al inicio, etc. Solo si nadie tiene nada que
// cerrar se deja que la app se cierre como siempre.
//
// En el navegador no hace nada (ahí el "atrás" es el del navegador).

import { Capacitor } from '@capacitor/core';

// Pila de manejadores: siempre manda el último registrado (la pantalla que
// está encima), como en cualquier app.
const manejadores = [];
let escuchando = false;

async function empezarAEscuchar() {
  if (escuchando || !Capacitor.isNativePlatform()) return;
  escuchando = true;
  try {
    const { App: CapApp } = await import('@capacitor/app');
    CapApp.addListener('backButton', ({ canGoBack }) => {
      // Se recorre de arriba hacia abajo: el primero que diga "yo me encargo"
      // (devolviendo true) se queda con el toque.
      for (let i = manejadores.length - 1; i >= 0; i--) {
        try {
          if (manejadores[i]() === true) return;
        } catch {
          /* si un manejador falla se prueba el siguiente */
        }
      }
      // Nadie lo tomó: se sale como lo haría cualquier app de Android.
      if (canGoBack) window.history.back();
      else CapApp.exitApp();
    });
  } catch {
    escuchando = false; // sin el plugin, el botón se comporta como siempre
  }
}

// Registra un manejador. `fn` devuelve true si ya se encargó del toque.
// Devuelve una función para quitarlo (al salir de la pantalla).
export function registrarAtras(fn) {
  manejadores.push(fn);
  empezarAEscuchar();
  return () => {
    const i = manejadores.indexOf(fn);
    if (i >= 0) manejadores.splice(i, 1);
  };
}

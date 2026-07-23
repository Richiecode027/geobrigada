import React from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import App from './App.jsx';

// Dentro del APK, un link de brigadista (https://geobrigada.netlify.app/?...)
// abre esta app en vez del navegador (ver AndroidManifest, App Links). Pero
// la app vive en su propia copia local, no en esa dirección: hay que tomar
// los parámetros ("?col=...&n=...&t=...") del link real y copiarlos aquí
// para que App.jsx lea la ruta correcta.
function copiarParametros(url) {
  try {
    const u = new URL(url);
    if (u.search) {
      window.history.replaceState(null, '', window.location.pathname + u.search);
      // Avisa a App.jsx (ya montado) que hay parámetros nuevos que leer.
      window.dispatchEvent(new Event('geobrigada:link'));
    }
  } catch {
    /* link no reconocido: se ignora y la app se queda donde estaba */
  }
}

async function aplicarLinkDeApertura() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { App: CapApp } = await import('@capacitor/app');
    // Arranque en frío: la app estaba cerrada y el link la abrió. IMPORTANTE:
    // getLaunchUrl() siempre regresa ESTE link original, aunque después
    // lleguen otros (no hay que volver a llamarlo tras el primer arranque).
    const lanzada = await CapApp.getLaunchUrl();
    if (lanzada && lanzada.url) copiarParametros(lanzada.url);
    // La app ya estaba abierta y llega otro link (p. ej. el brigadista toca
    // su link de nuevo desde WhatsApp): se actualiza sin recargar la página
    // (recargar volvería a preguntar por el link de arranque, que es el viejo).
    CapApp.addListener('appUrlOpen', (evento) => copiarParametros(evento.url));
  } catch {
    /* sin el plugin la app sigue abriendo normal, solo sin este atajo */
  }
}

aplicarLinkDeApertura().finally(() => {
  createRoot(document.getElementById('root')).render(<App />);
});

// PWA: registra el service worker (solo en producción, para no entorpecer
// el desarrollo). Permite que la app abra y funcione sin internet.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

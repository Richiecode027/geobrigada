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
// antes de que React arranque, para que lea la ruta correcta.
async function aplicarLinkDeApertura() {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { App: CapApp } = await import('@capacitor/app');
    // Arranque en frío: la app estaba cerrada y el link la abrió.
    const lanzada = await CapApp.getLaunchUrl();
    if (lanzada && lanzada.url) copiarParametros(lanzada.url);
    // La app ya estaba abierta y llega otro link (p. ej. el brigadista toca
    // su link de nuevo desde WhatsApp): se recarga con los parámetros nuevos.
    CapApp.addListener('appUrlOpen', (evento) => {
      const u = new URL(evento.url);
      window.location.href = window.location.origin + window.location.pathname + u.search;
    });
  } catch {
    /* sin el plugin la app sigue abriendo normal, solo sin este atajo */
  }
}

function copiarParametros(url) {
  try {
    const u = new URL(url);
    if (u.search) {
      window.history.replaceState(null, '', window.location.pathname + u.search);
    }
  } catch {
    /* link no reconocido: se ignora y la app abre en la vista del coordinador */
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

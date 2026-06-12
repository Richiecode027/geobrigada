// Service worker de GeoBrigada: hace que la app abra y funcione sin internet.
//
// Estrategia:
//  - La app (HTML, JS, CSS, catálogo): se sirve de la red cuando hay señal
//    (para recibir versiones nuevas) y del caché cuando no la hay.
//  - Los azulejos del mapa (OpenStreetMap): caché primero — un azulejo ya
//    visto no se vuelve a descargar; se guardan hasta ~700 (la colonia del
//    día cabe de sobra) y se van borrando los más viejos.
//  - Supabase y Overpass: siempre red (son datos vivos, no se cachean aquí).

const CACHE_APP = 'gb-app-v1';
const CACHE_TILES = 'gb-tiles-v1';
const MAX_TILES = 700;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const nombres = await caches.keys();
      await Promise.all(
        nombres
          .filter((n) => n !== CACHE_APP && n !== CACHE_TILES)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Datos vivos: nunca interceptar.
  if (url.hostname.includes('supabase.co') || url.hostname.includes('overpass')) {
    return;
  }

  // Azulejos del mapa: caché primero.
  if (url.hostname.includes('tile.openstreetmap.org')) {
    e.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_TILES);
        const guardado = await cache.match(req);
        if (guardado) return guardado;
        try {
          const resp = await fetch(req);
          if (resp.ok) {
            cache.put(req, resp.clone());
            limpiarTiles(cache);
          }
          return resp;
        } catch {
          return new Response('', { status: 408 });
        }
      })()
    );
    return;
  }

  // Navegación (abrir la app): red primero, caché si no hay señal.
  if (req.mode === 'navigate') {
    e.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_APP);
        try {
          const resp = await fetch(req);
          cache.put('/', resp.clone());
          return resp;
        } catch {
          const guardado = await cache.match('/');
          return guardado || new Response('Sin conexión', { status: 503 });
        }
      })()
    );
    return;
  }

  // Recursos de la propia app (JS, CSS, catálogo de colonias, íconos):
  // caché primero (los archivos llevan huella única por versión), y si no
  // está, red + guardar.
  if (url.origin === self.location.origin) {
    e.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_APP);
        const guardado = await cache.match(req);
        if (guardado) return guardado;
        try {
          const resp = await fetch(req);
          if (resp.ok) cache.put(req, resp.clone());
          return resp;
        } catch {
          return new Response('', { status: 408 });
        }
      })()
    );
  }
});

// Mantiene el caché de azulejos bajo control (borra los más viejos).
async function limpiarTiles(cache) {
  const llaves = await cache.keys();
  if (llaves.length <= MAX_TILES) return;
  const sobran = llaves.length - MAX_TILES + 50;
  for (let i = 0; i < sobran; i++) {
    await cache.delete(llaves[i]);
  }
}

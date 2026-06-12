# GeoBrigada

App web (React + Vite + Leaflet) para planear brigadas de reparto de material en
Morelia: divide colonias en rutas balanceadas por equipo, vista móvil con GPS
para brigadistas, registro de material repartido.

- El usuario es principiante en programación: explica en español y en términos
  sencillos; él opera, Claude desarrolla.
- La división de rutas (src/lib/partition.js) DEBE ser determinista (sin
  Math.random): los links de brigadista dependen de que cada teléfono recalcule
  la misma división. No introducir aleatoriedad ni reordenamientos no estables.
- Catálogo de colonias: `public/colonias_morelia.json`, generado por
  `node scripts/build-colonias.mjs` (límites oficiales INEGI DCAH 2023).
  La búsqueda por nombre es local; las calles vienen de Overpass en runtime
  (consulta por bbox + recorte local en src/lib/units.js, NO por poly).
- EN PRODUCCIÓN: https://geobrigada.netlify.app — Netlify construye y publica
  solo con cada push a `master` de github.com/Richiecode027/geobrigada.
  Publicar un cambio = commit + `git push`. No usar Netlify Drop.
- Commits SIN "Co-Authored-By" y con autor Richiecode027: el plan gratis de
  Netlify bloquea builds de repos privados si detecta colaboradores no
  verificados (incluye coautores en el mensaje del commit).
- Nube (fase 2, hecha): Supabase, tablas `reportes`, `posiciones` (en vivo) y
  `calles_cache` (esquema en scripts/esquema-supabase.sql, credenciales en
  src/lib/nube.js). Los reportes de brigadistas suben solos; el Historial
  combina nube + localStorage. Vistas del coordinador: Planear, En vivo
  (posiciones cada ~25 s), Cobertura (colonias y cuadras cubiertas), Historial.
- Es PWA: public/manifest.webmanifest + public/sw.js (service worker: app y
  azulejos del mapa sin internet). Íconos: `node scripts/gen-iconos.mjs`.
- Probar: `npm run dev` y preview en puerto 5180 (.claude/launch.json). GPS
  requiere HTTPS (`npm run dev:movil` para probar desde teléfono en LAN).
  Algoritmo: `node scripts/test-rutas.mjs` y
  `node scripts/debug-colonia.mjs "<colonia>" <equipos>`.
- Pendiente (fase 3): panel del coordinador con estadísticas y mapa de
  cobertura acumulada.

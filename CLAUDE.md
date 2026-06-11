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
  `node scripts/build-colonias.mjs` (polígonos por CP de SEPOMEX + nombres).
  La búsqueda por nombre es local; las calles vienen de Overpass en runtime.
- Probar: `npm run dev` y preview en puerto 5173. GPS requiere HTTPS
  (`npm run dev:movil` para probar desde teléfono en LAN).
- Fase 2 pendiente: Supabase para centralizar reportes de brigadistas.

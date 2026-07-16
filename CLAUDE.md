# GeoBrigada

App web (React + Vite + Leaflet) para planear brigadas de reparto de material en
Morelia: divide colonias en rutas balanceadas por equipo, vista móvil con GPS
para brigadistas, registro de material repartido.

- El usuario es principiante en programación: explica en español y en términos
  sencillos; él opera, Claude desarrolla.
- La división de rutas (src/lib/partition.js) DEBE ser determinista (sin
  Math.random): los links de brigadista dependen de que cada teléfono recalcule
  la misma división. No introducir aleatoriedad ni reordenamientos no estables.
- Catálogo de colonias: `public/colonias_morelia.json`, 934 polígonos armados
  en 3 pasos (correr en orden tras una actualización del INEGI):
    1. `node scripts/build-colonias.mjs` — límites oficiales INEGI DCAH 2024
       (archivo nacional): 926 zonas = 715 colonias con nombre + 211 "Zona
       NNNN (sin nombre oficial)" (delimitadas por IMPLAN sin nombre).
    2. `node scripts/build-viviendas.mjs` — cruza Censo 2020 x Marco
       Geoestadístico por manzana, escribe el campo "v" (viviendas) de cada
       zona del paso 1.
    3. `node scripts/build-tenencias.mjs` — el DCAH solo cubre la ciudad
       (localidad 0001); las tenencias (Capula, Morelos, Jesús del Monte...)
       quedan fuera. Este paso agrupa por localidad las manzanas del Marco
       Geoestadístico que NO caen en ninguna zona del catálogo, suelda sus
       polígonos con turf (buffer+union+erode, tolerante a que estén
       separados por calles) y las agrega como zonas tipo "Tenencia" con
       viviendas reales del censo. Suma 8 tenencias, ~934 zonas totales.
  Al cambiar el catálogo hay que subir la versión del caché en public/sw.js.
  La búsqueda por nombre es local; las calles vienen de Overpass en runtime
  (consulta por bbox + recorte local en src/lib/units.js, NO por poly) —
  ya probado con Capula (calles reales, rutas generadas sin problema).
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
- Cada brigada lleva ACTIVIDAD (Folletos, Calendarios, Visita...; param `act`
  del link, default "Reparto"): separa avance, reportes y cobertura de visitas
  repetidas a la misma colonia. La Cobertura filtra por actividad.
- Jerarquía completa (params del link: camp, act, brig, t): CAMPAÑA (Presidencia,
  Diputación…) › ACTIVIDAD › BRIGADA (~10, se reparten colonias) › EQUIPOS (parten
  la colonia). La vista "Brigadas" (src/views/Brigadas.jsx) reparte colonias entre
  brigadas con src/lib/brigadas.js (greedy ponderado por viviendas INEGI y jornada
  completo=1/medio=0.5, determinista); el plan se guarda en localStorage. Tocar
  "Planear ▸" manda la colonia a Planear vía contexto en App.jsx. Cobertura filtra
  por campaña y actividad.
- Es PWA: public/manifest.webmanifest + public/sw.js (service worker: app y
  azulejos del mapa sin internet). Íconos: `node scripts/gen-iconos.mjs`.
- Versión APK Android (Capacitor, plan en docs/version-movil-apk.md): la MISMA
  app React envuelta en cáscara nativa, carpeta `android/` +
  capacitor.config.json. Compilar: `npm run apk` (hace vite build + cap sync +
  gradle); sale en android/app/build/outputs/apk/debug/app-debug.apk. Gradle
  usa el Java de Android Studio (configurado en ~/.gradle/gradle.properties;
  el Java del PATH es 1.8 y no sirve) y el SDK de
  %LOCALAPPDATA%/Android/Sdk (android/local.properties, no se commitea).
  Íconos/splash del APK: `node scripts/gen-iconos-android.mjs`. GPS: fuente
  única en src/lib/gps.js — navegador usa watchPosition, APK usa
  @capacitor-community/background-geolocation (sigue con pantalla apagada,
  notificación persistente; useLegacyBridge y CapacitorHttp activados en
  capacitor.config.json para que ni el GPS ni las subidas a Supabase se
  congelen a los 5 min en segundo plano). Pendiente: OTA de la capa web con
  @capgo/capacitor-updater (zip en Netlify) — ver conversación 15 jul 2026.
- Probar: `npm run dev` y preview en puerto 5180 (.claude/launch.json). GPS
  requiere HTTPS (`npm run dev:movil` para probar desde teléfono en LAN).
  Algoritmo: `node scripts/test-rutas.mjs` y
  `node scripts/debug-colonia.mjs "<colonia>" <equipos>`.
- Pendiente (fase 3): panel del coordinador con estadísticas y mapa de
  cobertura acumulada.

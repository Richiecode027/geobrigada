# GeoBrigada — Versión móvil (APK) con GPS en segundo plano

> Documento de traspaso para arrancar el trabajo de la app Android en un chat
> nuevo, sin mezclarlo con el desarrollo de la web. **Mismo repositorio, chat
> aparte.**

## Por qué hacemos esto

La versión web tiene una limitación de raíz: cuando el brigadista **bloquea la
pantalla o cambia de app**, el navegador congela el JavaScript y el GPS deja de
registrar. Se pierden pedazos del recorrido y el porcentaje de avance queda
incompleto. Esto **no se puede arreglar en la web** — es una restricción
deliberada de los navegadores móviles (batería y privacidad). El `Wake Lock`
que ya existe solo mantiene la pantalla encendida en primer plano; no sobrevive
a que el teléfono se guarde en el bolsillo.

La solución es empaquetar la app como **aplicación Android nativa (APK)**, que
sí puede seguir el GPS en segundo plano (como Strava, Uber, apps de reparto).

## Qué es GeoBrigada (contexto rápido)

App web (React + Vite + Leaflet) para planear brigadas de reparto de material
de campaña en Morelia. El coordinador divide colonias en rutas balanceadas por
equipo; cada brigadista abre un link con su ruta, activa el GPS y camina; al
terminar registra el material repartido. Hay una nube (Supabase) donde suben los
reportes y las posiciones en vivo. Ver `CLAUDE.md` para la arquitectura completa.

## El problema exacto a resolver

- `navigator.geolocation.watchPosition` (en `src/views/Brigadista.jsx`) se
  pausa con la pantalla bloqueada o la app en segundo plano.
- Necesitamos: **seguir registrando ubicación con la pantalla apagada, durante
  horas**, sin huecos en el rastro ni en el porcentaje de avance.

## Enfoque recomendado: Capacitor (envolver, no reescribir)

- **Capacitor** envuelve la MISMA app de React en una cáscara nativa y genera un
  APK. Se reutiliza prácticamente todo el código actual.
- Se agrega un **plugin de geolocalización en segundo plano** (hay varios;
  algunos gratuitos como `@capacitor-community/background-geolocation`, otros de
  pago con más features — evaluar en el chat nuevo cuál conviene).
- La vista del brigadista usaría ese plugin en lugar de `watchPosition` cuando
  corre dentro del APK; en la web sigue usando `watchPosition` como hoy
  (detectar el entorno y elegir la fuente de GPS).
- **Android**: el APK se reparte directo por WhatsApp e instala sin Google Play.
  Pide permiso de ubicación "permitir todo el tiempo" y muestra una notificación
  persistente ("GeoBrigada está registrando tu recorrido").

## Lo que NO se debe romper (crítico)

- **Determinismo de `src/lib/partition.js`**: cada teléfono recalcula la misma
  división de rutas. Nada de `Math.random` ni reordenamientos inestables.
- **Mismo Supabase y mismo esquema de links** (`src/lib/links.js`,
  `src/lib/nube.js`): el APK sube reportes/posiciones igual que la web.
- **Un solo repositorio**: Capacitor se monta encima (carpeta `android/`,
  `capacitor.config.*`, apuntando al `dist/` que ya genera `npm run build`).
  La web sigue publicándose en Netlify sin cambios. NO crear un segundo
  codebase — se desincronizaría y habría que arreglar todo dos veces.
- **Commits sin "Co-Authored-By" y autor `Richiecode027 <slasherbaird@gmail.com>`**
  (el plan gratis de Netlify bloquea builds si detecta coautores).

## Realidad de iOS (leer antes de prometer nada)

- Distribuir una app iOS fuera de la App Store es difícil: requiere Mac, Xcode,
  cuenta de Apple Developer (~$99 USD/año) y revisión de Apple.
- **Recomendación: Android primero.** Los iPhone pueden seguir usando la web
  mientras tanto.

## Cómo arrancar el chat nuevo

1. Abrir un chat nuevo en **el mismo repo**: `C:\Users\rc_ju\Desktop\GeoBrigada`
2. Primer mensaje sugerido:
   > "Lee `docs/version-movil-apk.md` y `CLAUDE.md`. Vamos a hacer la versión
   > APK para Android con GPS en segundo plano, empezando por probar Capacitor
   > sobre el código actual."
3. Primer objetivo realista: generar un APK que abra la app tal cual (sin GPS de
   fondo todavía) e instalarlo en un teléfono. Una vez que eso funcione, agregar
   el plugin de background-geolocation a la vista del brigadista.

## Estado actual del proyecto (al escribir esto)

- En producción: https://geobrigada.netlify.app (deploy = `git push` a master).
- Catálogo: 934 zonas (715 colonias DCAH + 211 zonas sin nombre + 8 tenencias).
- Nube Supabase conectada y funcionando.
- La vista guiada del brigadista (mapa que gira tipo Waze, resalta la calle
  siguiente) ya está hecha y en producción.

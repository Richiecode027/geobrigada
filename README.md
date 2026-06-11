# 🗺️ GeoBrigada

Herramienta web para planear y dar seguimiento a brigadas de reparto de material
en Morelia, Michoacán. Divide una colonia en rutas balanceadas para N equipos,
le da a cada brigadista un mapa con GPS en su teléfono, y registra el material
repartido al final de cada recorrido.

## Cómo funciona (resumen para el coordinador)

1. **Busca la colonia** por nombre (catálogo local con 715 colonias de Morelia
   con sus **límites oficiales** del INEGI, delimitados por el IMPLAN de Morelia).
   Si alguna zona no aparece, puedes dibujarla a mano tocando el mapa.
2. **Escribe cuántos equipos hay hoy** (1–8) y presiona "Generar rutas".
   La app obtiene las calles reales de OpenStreetMap y las reparte en rutas
   balanceadas por kilómetros.
3. **Envía a cada equipo su link por WhatsApp.** El brigadista lo abre en su
   teléfono: ve su ruta en color, su ubicación GPS en vivo y la lista de calles
   en orden de recorrido.
4. Al terminar, el brigadista presiona **"Terminé mi recorrido"**, captura
   cuánto material repartió y envía el resumen por WhatsApp al coordinador.
   El reporte queda guardado en su teléfono (pestaña Historial).

> 💡 Los links funcionan sin servidor: el algoritmo de división es determinista,
> así que el teléfono del brigadista recalcula exactamente las mismas rutas que
> vio el coordinador.

## Correr el proyecto en tu computadora

Necesitas [Node.js](https://nodejs.org) (ya instalado en esta máquina).

```bash
npm install        # solo la primera vez
npm run dev        # abre http://localhost:5173
```

### Probar el GPS desde tu teléfono (misma red WiFi)

El GPS del navegador solo funciona con HTTPS, por eso hay un modo especial:

```bash
npm run dev:movil
```

Abre en el teléfono la dirección `https://<IP-de-tu-PC>:5173` (la terminal la
muestra como "Network"). El navegador avisará que el certificado no es de
confianza — es normal en pruebas, acepta "continuar".

## Publicar en internet (gratis)

Para que los brigadistas usen la app en campo necesita estar publicada con HTTPS.

**Opción A — Netlify Drop (la más fácil, sin instalar nada):**

1. Corre `npm run build`. Se crea la carpeta `dist`.
2. Entra a https://app.netlify.com/drop y arrastra la carpeta `dist`.
3. Te da una URL tipo `https://algo.netlify.app` — esa es tu app.
   (Crea una cuenta gratis para que la URL no expire y puedas actualizarla.)

**Opción B — Vercel (mejor para actualizar seguido):**

```bash
npm run build
npx vercel deploy --prod
```

Cada vez que cambies algo: repite build + deploy.

## Actualizar el catálogo de colonias

El archivo `public/colonias_morelia.json` se genera con:

```bash
node scripts/build-colonias.mjs
```

Fuente (se descarga sola si hace falta): INEGI, programa
[DCAH — Delimitación de Colonias y otros Asentamientos Humanos](https://www.inegi.org.mx/programas/dcah/)
(edición 2023, Michoacán). Son los límites oficiales avalados por el Instituto
Municipal de Planeación de Morelia. Cuando INEGI publique una edición nueva,
basta volver a correr el script.

## Limitaciones actuales y siguientes fases

- El catálogo cubre las 715 colonias **con nombre oficial** del DCAH; las zonas
  delimitadas sin nombre oficial (211) y los asentamientos muy nuevos se cubren
  con "Dibujar colonia a mano".
- **Los reportes se guardan en el teléfono de cada brigadista** y se comparten
  por WhatsApp. La fase 2 es conectar Supabase (gratis) para que todos los
  reportes lleguen automáticamente a un panel central del coordinador, con
  estadísticas y mapa de cobertura acumulada de toda la campaña.
- Las rutas optimizan que cada equipo tenga una zona compacta y balanceada en
  kilómetros; no calculan el camino puerta-a-puerta perfecto (eso casi nunca
  hace falta para volanteo).

## Estructura del código

```
src/
  App.jsx              Decide si mostrar vista coordinador o brigadista
  views/
    Coordinador.jsx    Buscar colonia, generar rutas, compartir links
    Brigadista.jsx     Ruta propia + GPS + checklist + reporte de material
    Historial.jsx      Reportes guardados en este dispositivo
  lib/
    colonias.js        Catálogo local de colonias (búsqueda y polígonos)
    partition.js       División de calles en N equipos (determinista) y orden de recorrido
    units.js           Convierte calles de OSM en tramos repartibles
    geo.js             Distancias, punto-en-polígono, simplificación
    links.js           Links compartibles por equipo
    storage.js         Guardado local (reportes y progreso)
  api/
    overpass.js        Descarga las calles de OpenStreetMap
scripts/
  build-colonias.mjs   Regenera public/colonias_morelia.json
```

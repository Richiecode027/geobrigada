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
  La consulta/clave de caché vive en src/lib/calles-query.js (compartida por
  la app y por scripts/precargar-calles.mjs, que sube las calles de las 934
  zonas al caché de Supabase para que los teléfonos no dependan de Overpass;
  correrlo de nuevo si cambia la consulta o el catálogo). Si Overpass falla,
  la app usa como salvavidas el caché vencido (local o nube).
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
- BARDAS (jul 2026, fase de pintar bardas con el nombre del candidato): es OTRO
  problema que el reparto de folletos — no hay que cubrir todas las calles de
  una colonia, sino llegar a PUNTOS sueltos (posiblemente de varias colonias) a
  pedirle permiso al dueño. Por eso NO usa partition.js: src/lib/bardas.js
  ordena por "vecino más cercano" desde donde está parado el equipo (determinista).
  El catálogo (public/bardas.json) sale del Excel que llena quien busca bardas
  en carro: `node scripts/build-bardas.mjs "<ruta al .xlsx>"`. Ese Excel trae la
  ubicación como LINK CORTO de Google Maps, no como coordenadas: el script las
  resuelve leyendo solo la cabecera de redirección (redirect:'manual') — pedir
  la página completa dispara el captcha de Google y devuelve 200 sin
  coordenadas. También arregla los acentos (viene con doble codificación,
  "UniÃ³n"). Las bardas sin link se listan aparte en la vista, por dirección.
  El resultado de cada visita va a la tabla `bardas_permisos` de Supabase.
  Si el Excel trae fotos incrustadas EN CELDA (función de Excel 365, no el
  link de Drive de la columna FOTO), `node scripts/empotrar-fotos-excel.mjs
  "<xlsx>"` las comprime y las deja acotadas cada una a su celda (si no,
  salen como "#VALUE!" fuera de Excel 365); luego
  `node scripts/agregar-fotos-bardas.mjs "<xlsx con fotos en celda>"` las
  saca a public/bardas-fotos/<id>.jpg y llena el campo `foto` del catálogo —
  el link de Drive NUNCA se guarda ahí, solo fotos incrustadas de verdad.
  Además del catálogo (fijo, sale del Excel), cualquier equipo puede AGREGAR
  una barda nueva desde la propia app ("¿Encontraste una barda que no está en
  la lista?"): la ubicación es obligatoria (una sola lectura de GPS, ver
  obtenerPosicionActual en src/lib/gps.js) y la foto es opcional — se
  comprime en el celular (src/lib/imagen.js, createImageBitmap) antes de
  subirse al bucket público `bardas-fotos-nuevas` de Supabase Storage. La fila
  va a la tabla `bardas_nuevas` (id lo genera el celular) y al cargar la vista
  se mezcla con el catálogo del Excel (aBardaCatalogo en Bardas.jsx), así que
  sale igual en el mapa, la búsqueda y el cálculo de rutas. En vez de GPS
  también se puede pegar un link de Google Maps (como los del Excel): un link
  LARGO ya trae las coordenadas y se leen directo en el navegador
  (src/lib/mapsLink.js); uno CORTO (maps.app.goo.gl) hay que resolverlo del
  lado del servidor porque el navegador no puede leer a dónde redirige un
  dominio ajeno (CORS) — para eso existe
  netlify/functions/resolver-link-maps.js (mismo truco que build-bardas.mjs,
  pero en vivo); esa función SOLO corre en Netlify, no en `npm run dev`.
  Reservas (jul 2026): si dos equipos arrancan su recorrido casi al mismo
  tiempo y cerca uno del otro, el algoritmo determinista les daría LA MISMA
  ruta. Por eso, justo antes de calcular, se consulta `bardas_reservadas`
  (tabla nueva) y se excluyen las bardas que otro equipo ya trae en su ruta;
  al terminar de calcular, el equipo aparta las suyas. Si la consulta falla,
  se sigue sin filtrar (mejor una posible repetida que trabar la ruta).
  La reserva dura POCO (45 min) y se renueva sola cada 10 min mientras el
  equipo trae la app abierta: con las 3 horas fijas del primer intento, a
  quien se le cerraba la app dejaba sus bardas bloqueadas toda la tarde para
  todos, incluido él. Además la jornada se guarda en el teléfono
  (localStorage `geobrigada_bardas_sesion`: equipo, cantidad, fase y ruta), y
  al reabrir se ofrece "Retomar recorrido" con LA MISMA ruta y orden — sin
  recalcular, solo quitando lo que ya se registró. Guardar una barda,
  "Terminar recorrido" o "Empezar uno nuevo" sueltan la reserva en el acto.
  Ojo: el nombre del equipo se guarda siempre, porque de ahí depende que la
  app reconozca sus PROPIAS reservas en vez de verlas como de otro.
- Cada visita guarda un ESTADO en `bardas_permisos.estado` (la columna vieja
  `permiso` se sigue llenando para el Excel y los scripts): `con_permiso`,
  `sin_permiso`, `visitado` (fue pero no había nadie) y `no_habitado` (casa
  sola). Los tres últimos cierran la barda para siempre EXCEPTO `visitado`,
  que solo sale de la ruta del día y vuelve a pendientes al siguiente — a esa
  barda nunca se le preguntó a nadie (ver bardaAtendida en src/lib/bardas.js).
- Corte para la oficina: botón "Exportar corte a Excel" en la vista Bardas
  (src/lib/corteBardas.js), con filtro Todas / Solo visitadas / Solo con
  permiso. Sigue el reporte que ya se usa (NO./BRIGADA/DIRECCION/COLONIA/
  DISTRITO//REFERENCIAS/COMPROMISO) pero con UNA sola columna ESTADO en vez
  de las casillas CON PERMISO y SIN PERMISO (no alcanzaban para los cuatro
  resultados), más EQUIPO, ATENDIÓ, TELÉFONO, NOTAS y REGISTRADO. `xlsx` es
  dependencia de runtime pero queda en su propio chunk: solo se descarga al
  tocar el botón, nunca en la app del brigadista.
- Al agregar una barda nueva, src/lib/ubicacion.js llena solos colonia,
  distrito y calle desde la ubicación. La COLONIA sale del catálogo INEGI que
  ya trae la app (local, sin internet); la CALLE de Nominatim (el número casi
  nunca está en OSM para Morelia, ese se teclea); el DISTRITO se deduce —la
  app no tiene los polígonos de distritos electorales— del propio catálogo de
  bardas: primero por nombre de colonia y si no, por la barda conocida más
  cercana (máx. 2.5 km, si no se deja vacío). Probado dejando fuera cada barda
  y adivinando su distrito con las otras 164: 164 aciertos, 0 errores, 1 vacía.
  Dirección y colonia quedan editables porque son aproximación; el distrito NO
  se pregunta (ubicación + calle + colonia ya identifican la barda, y un campo
  más estorba en la calle) pero sí se guarda, porque el corte lo lleva como
  columna. El número de casa no se pide: OSM casi no lo tiene en Morelia.
- Tocar una barda (pin del mapa o lista) despliega el panel si estaba plegado
  y baja solo hasta su ficha: antes había que abrirlo y buscarla a mano.
- La ubicación propia se ve SIEMPRE, no solo en recorrido: fuera de ruta el
  GPS corre en "modo ligero" (iniciarGPS con segundoPlano:false — sin la
  notificación permanente ni la entrega nativa del APK, que ahí sería
  abusiva). El puntito es una flecha que gira con la brújula
  (src/lib/brujula.js: webkitCompassHeading en iOS, deviceorientationabsolute
  en Android, descontando el giro de pantalla); si el aparato no tiene
  brújula, se dibuja el punto de antes.
- El equipo se puede editar AL registrar cada barda, no solo en la pantalla de
  inicio: sirve para capturar las que otro equipo hizo a mano. Al reabrir una
  barda ya registrada se respeta el equipo original en vez de reasignarla.
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

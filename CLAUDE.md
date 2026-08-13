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
  sale igual en el mapa, la búsqueda y el cálculo de rutas. Esas SÍ se pueden
  corregir y quitar desde la ficha (botones Editar / Eliminar, este último con
  doble confirmación); las del Excel no, porque viven en un archivo del sitio
  y no en la nube — de ahí la bandera `agregadaEnApp`. Quitar no borra la
  fila: marca `borrado` (igual que `anulado` en bardas_permisos) y la consulta
  filtra por él. Al reemplazar la foto se sube con `x-upsert` sobre la
  anterior y la URL lleva `?v=<hora>` para que el celular no siga enseñando la
  vieja de su caché. Su nombre en listas y mapa (nombreBarda en Bardas.jsx)
  NUNCA es el id crudo (un uuid no dice nada); si falta la dirección se usa
  la colonia, y si dos bardas nuevas comparten el mismo nombre de calle —muy
  común, OSM repite el nombre en tramos largos, llegó a pasar 8 veces con la
  misma calle— se numeran en el orden en que se capturaron. En vez de GPS
  también se puede pegar un link de Google Maps (como los del Excel): un link
  LARGO ya trae las coordenadas y se leen directo en el navegador
  (src/lib/mapsLink.js); uno CORTO (maps.app.goo.gl) hay que resolverlo del
  lado del servidor porque el navegador no puede leer a dónde redirige un
  dominio ajeno (CORS) — para eso existe
  netlify/functions/resolver-link-maps.js (mismo truco que build-bardas.mjs,
  pero en vivo); esa función SOLO corre en Netlify, no en `npm run dev`.
  APARTAR (jul 2026, rediseñado): el equipo elige A MANO qué bardas va a
  hacer. En la ficha de cada barda, el campo "Equipo que la aparta / la hizo"
  ES el apartado: con nombre queda apartada en `bardas_reservadas`, sin
  nombre queda libre. NO vence ni necesita latido — por eso aguanta que se
  cierre la app, se acabe la pila o se pierda el teléfono (la columna `vence`
  se conserva por compatibilidad y se escribe en 2099). Se suelta al borrar
  el nombre, con "Soltar todas", o sola al registrar la visita.
  La RUTA se calcula después, con "🧭 Calcular mi ruta": toma lo que el
  equipo ya apartó y solo lo ORDENA (rutaDeBardasPorCalles ya no elige ni
  descarta nada). Antes la app escogía sola una "zona compacta" de N bardas
  al arrancar el recorrido y las apartaba con vencimiento de 45 min +
  renovación cada 10 min, y consultaba las reservas cada 30 s: eso era el
  ~90% de todo el tráfico a Supabase en una jornada (~6.7 MB por teléfono al
  día contra ~70 KB ahora), y ataba el apartado a que la sesión siguiera
  viva. Las reservas se leen al abrir, al calcular ruta y al guardar; nada de
  temporizadores (el único setInterval que queda es el de EnVivo.jsx).
  La jornada se sigue guardando en el teléfono (localStorage
  `geobrigada_bardas_sesion`: equipo, fase y ruta) pero ya solo para
  conservar el ORDEN: "Retomar recorrido" no vuelve a apartar nada porque las bardas
  nunca se soltaron. Ojo: el nombre del equipo se guarda siempre, porque de
  ahí depende que la app distinga sus bardas (pin azul 📌) de las de otro
  equipo (pin naranja 🔒). En la ficha, el botón "📌 Apartar para X" / "🔓
  Quitar apartado" (junto a "Cómo llegar") lo hace de un toque, sin pasar por
  el formulario de abajo — ese ya solo registra el resultado de la visita. Si
  "Tu equipo" está vacío el botón se deshabilita con su propio aviso: no hay
  a nombre de quién apartar.
- Cada visita guarda un ESTADO en `bardas_permisos.estado` (la columna vieja
  `permiso` se sigue llenando para el Excel y los scripts): `con_permiso`,
  `sin_permiso`, `visitado` (fue pero no había nadie) y `no_habitado` (casa
  sola). Los cuatro cierran la barda (ver bardaAtendida en src/lib/bardas.js):
  antes `visitado` volvía sola a pendientes al día siguiente, pero eso
  confundía al equipo cuando la veía "perdida" — ahora se queda así hasta que
  alguien la reabra y cambie el resultado a mano.
- La fecha del corte (columna REGISTRADO) es la del PRIMER registro, no la de
  la última corrección: importa para llevar control de cuándo se visitó
  cada barda de verdad. `bardas_permisos.primer_registro` se llena una sola
  vez; un trigger en Supabase (no el código del teléfono) impide que se
  toque después, sin importar qué mande el cliente — garantizado aunque
  cambie el código en el futuro. `actualizado` se sigue moviendo con cada
  edición, para lo que ya se usaba (orden de lectura); el corte lee de
  `primer_registro`, con `actualizado` como respaldo si esa columna aún no
  existe en la base.
- Corte para la oficina: botón "Exportar corte a Excel" en la vista Bardas
  (src/lib/corteBardas.js), con filtro Todas / Solo visitadas / Solo con
  permiso. Las columnas y su orden son EXACTO el archivo que ya usa la
  oficina para pasar bardas a pintura ("PINTA DE BARDAS MORELIA", hoja
  BARDAS): RESPONSABLE (nuestro `equipo`) / BRIGADA / NOMBRE / TELEFONO /
  DIRECCION (CALLE Y NUMERO) / COLONIA / DISTRITO / REFERENCIAS / STATUS
  (AUTORIZADO O VISTA — nuestros 4 resultados se reducen a Autorizada si
  hubo permiso, Vista si se visitó sin permiso, vacío si sigue pendiente) /
  COMENTARIOS / BRIGADA QUE ASISTE / FECHA DE PROGRAMACION (estas dos
  últimas las llena la oficina a mano después, siempre salen vacías de
  aquí). Al final, aparte de esas columnas oficiales, van BUENA (de
  bardas_calidad), COMPROMISO y REGISTRADO, que ya teníamos y no estorban
  al formato. Las bardas agregadas desde el teléfono nunca traen el link de
  Maps del Excel original (columna REFERENCIAS): sin esto salían con la
  ubicación en blanco en el corte, así que ahí se arma un link a partir de
  su lat/lng. `xlsx` es dependencia de runtime pero queda en su propio
  chunk: solo se descarga al tocar el botón, nunca en la app del
  brigadista. Todo el corte sale en MAYÚSCULAS (lo pide la oficina así),
  salvo la columna REFERENCIAS: es un link (los códigos cortos de Maps
  distinguen mayúsculas de minúsculas) y ponerlo en mayúsculas lo rompería.
- Al agregar una barda nueva, src/lib/ubicacion.js llena solos colonia,
  distrito y calle desde la ubicación. La COLONIA sale del catálogo INEGI que
  ya trae la app (local, sin internet); la CALLE de Nominatim; el DISTRITO del
  trazo OFICIAL del INE (ver abajo), con la deducción vieja (por colonia o
  barda vecina) ya solo de respaldo si el punto cae fuera de Morelia.
  Dirección y colonia quedan editables; el distrito NO se pregunta (ubicación
  + calle + colonia ya identifican la barda) pero sí se guarda, porque el
  corte lo lleva como columna. El número de casa no se pide: OSM casi no lo
  tiene en Morelia. El GPS arranca a pedirse en cuanto se abre el formulario,
  así que si el equipo pega un link para dar de alta una barda que NO es
  donde está parado, es normal que el GPS (de donde sí está) le gane la
  carrera y llene colonia/calle con su propia ubicación antes de que el link
  resuelva. Por eso `usarLink` borra esos tres campos justo antes de fijar
  las coordenadas del link: si no, el autollenado de arriba no los vuelve a
  tocar porque ya no están vacíos (esa regla existe para no pisar lo que el
  equipo escribió a mano) y se quedaban con la ubicación equivocada aunque
  el pin sí quedara bien puesto.
- DISTRITOS LOCALES (jul 2026): `public/distritos_morelia.json` (71 KB) trae
  los límites oficiales de los 4 distritos electorales LOCALES que cubren el
  municipio de Morelia — 10, 11, 16 y 17 — recortados al municipio (incluye
  las tenencias, que son parte de él). Se generan con
  `node scripts/build-distritos.mjs "<ruta al .7z del INE>"`, que baja de
  https://cartografia.ine.mx/sige8/productosCartograficos/bases (producto
  "BGD - BASE GEOGRÁFICA DIGITAL", entidad Michoacán, Shapefile, ~58 MB .7z,
  corte dic 2025; se descomprime con 7zip-min, viene en UTM 14N y el script
  reproyecta y simplifica). OJO: la base trae DOS capas parecidas,
  DISTRITO_FEDERAL y DISTRITO_LOCAL, con numeraciones distintas — se usa la
  LOCAL, y el script ABORTA si los distritos que salen no son exactamente
  10, 11, 16 y 17 (esa es la señal de que se agarró la capa equivocada o
  cambió la distritación). Verificado con
  `node scripts/debug-distritos.mjs`: de las 165 bardas con distrito escrito
  a mano en el Excel, las 165 coinciden con el polígono oficial, 0 discrepan,
  y ubica el 100% de las bardas con coordenadas. La vista Bardas los dibuja
  con un botón para ocultarlos (src/lib/distritos.js).
- Tocar una barda (pin del mapa o lista) despliega el panel si estaba plegado
  y baja solo hasta su ficha: antes había que abrirlo y buscarla a mano.
- Bardas que caen en la MISMA coordenada exacta (ago 2026): pasa seguido con
  las del Excel (un link corto de Maps resolvió al centro de la cámara en vez
  del marcador preciso, y coincidió con otra barda cercana) y con las
  agregadas desde el teléfono (el GPS dio la misma lectura para varias
  capturadas seguidas en el mismo lugar). Sin arreglo, la que se dibuja
  después tapa por completo a la de abajo: no se ve como "dos pines
  pegados", se ve como si solo hubiera uno, y ese pin resulta ser el
  equivocado — se puede confundir con que la barda "no está" o con el estado
  de otra. `posicionParaDibujar` en Bardas.jsx agrupa por coordenada
  (redondeada a 5 decimales) y separa en círculo (~6 m) SOLO para dibujar;
  la ubicación real que usan la ruta, "Cómo llegar" y el corte de Excel no
  cambia. A un zoom muy alejado (toda la ciudad) el desplazamiento vuelve a
  verse pegado —6 m son menos de un pixel ahí— pero a la distancia real con
  la que se camina una colonia ya quedan separados y tocables.
- Qué teléfono hizo cada cambio (ago 2026): src/lib/dispositivo.js le inventa
  a cada aparato un código al azar la primera vez (guardado en su
  localStorage) y viaja en la columna `dispositivo` de bardas_permisos,
  bardas_nuevas, bardas_calidad y bardas_reservadas cada vez que ese teléfono
  sube algo. NO es un identificador de hardware — ningún navegador deja leer
  eso, por privacidad — así que se pierde si borran datos del navegador o
  reinstalan la app. Sirve para, ante un caso raro como el de las bardas 79 y
  80 (dos bardas cayendo en la misma coordenada exacta), poder agrupar qué
  cambios salieron del mismo aparato aunque no haya escrito su nombre de
  equipo esa vez — antes no había ninguna forma de saberlo.
- La ubicación propia se ve SIEMPRE, no solo en recorrido: fuera de ruta el
  GPS corre en "modo ligero" (iniciarGPS con segundoPlano:false — sin la
  notificación permanente ni la entrega nativa del APK, que ahí sería
  abusiva). El puntito es una flecha que gira con la brújula
  (src/lib/brujula.js: webkitCompassHeading en iOS, deviceorientationabsolute
  en Android, descontando el giro de pantalla); si el aparato no tiene
  brújula, se dibuja el punto de antes. Es un marcador NO interactivo
  (interactive:false + pointer-events:none en CSS): antes se quedaba con los
  toques cuando el equipo estaba parado justo junto a una barda recién
  registrada —el caso más común— y no dejaba abrirla.
- App abre en la pestaña Bardas (App.jsx), no en Planear: es la actividad del
  momento. El mapa además se centra solo en la ubicación del equipo en cuanto
  llega la primera lectura de GPS (una vez, no vuelve a moverlo solo después):
  antes arrancaba mostrando todo Morelia y había que buscarse entre cientos
  de pines.
- El asa para plegar/desplegar el panel en el teléfono (src/components/
  AsaPanel.jsx, usada en Bardas y Coordinador) es solo la barrita, sin texto,
  y se puede arrastrar además de tocar: hacia abajo pliega, hacia arriba
  despliega, como el tirador de una hoja a media pantalla en cualquier app
  nativa.
- El equipo se puede editar AL registrar cada barda, no solo en la pantalla de
  inicio: sirve para capturar las que otro equipo hizo a mano. Al reabrir una
  barda ya registrada se respeta el equipo original en vez de reasignarla.
- "¿Es buena barda?" (ago 2026): checkbox en la ficha, aparte de "Guardar" —
  se guarda solo al tocarlo, en `bardas_calidad` (independiente de si ya se le
  preguntó al dueño: sirve para decidir por dónde empezar). El pin en el mapa
  lleva un anillo dorado (box-shadow, no tapa el color de estado).
- Varias fotos por barda (ago 2026): el selector de foto al agregar/corregir
  acepta `multiple`; cada una se sube con su propio nombre de archivo (antes
  siempre era "<id>.jpg", bueno solo para una) y se guardan en el arreglo
  `bardas_nuevas.fotos`. `foto` (singular) se conserva como respaldo de las
  que ya estaban antes de que se pudiera subir más de una. La ficha las
  enseña en una franja que se desliza con el dedo (`scroll-snap` de CSS, no
  JS propio de arrastre — para no repetir el bug de eventos táctiles pasivos
  de AsaPanel). El `<input type="file">` NO lleva `capture="environment"`:
  con ese atributo, la mayoría de los celulares (sobre todo Android) abren la
  cámara directo y ni siquiera enseñan la opción de elegir de la galería —
  lo cual también impedía agregarle foto después a una barda que se guardó
  sin ninguna, porque para entonces el equipo ya no está parado ahí.
- Ver una colonia en el mapa (ago 2026): mantener presionado un punto dibuja
  su polígono y nombre (`map.on('contextmenu', …)`, que dispara igual con
  long-press en el teléfono y clic derecho en computadora — sin temporizador
  táctil propio). También hay un buscador por nombre. Sirve para saber qué
  calles tocan a una colonia sin tener que adivinar por dónde va su límite;
  antes había que ir tocando bardas una por una para ubicarse.
- Filtro de qué se ve en el mapa (ago 2026): checkboxes por resultado (sin
  visitar, con permiso, sin permiso, visitado, no habitado) sobre el efecto
  que dibuja los pines — no son listas aparte, así que no hay que
  mantenerlas sincronizadas con nada más. Aparte va "solo las marcadas como
  buenas": no es un resultado de visita, es la etiqueta de bardas_calidad, así
  que se cruza con cualquier estado en vez de vivir en el mismo Set.
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

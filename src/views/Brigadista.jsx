import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap, marcadorInicio, marcadorEncuentro, marcadorFin, flechasDeRecorrido } from '../components/useMap.js';
import { ringsPorClave } from '../lib/colonias.js';
import { obtenerCalles } from '../api/overpass.js';
import { buildUnits } from '../lib/units.js';
import { partition, orderRoute, recorridoContinuo, caminoACalle, puntoDeEncuentro, TEAM_COLORS } from '../lib/partition.js';
import { ringsBounds, haversine, partirTrayectoria } from '../lib/geo.js';
import { decodificarPoly } from '../lib/links.js';
import {
  guardarReporte,
  cargarProgreso,
  guardarProgreso,
  limpiarProgreso,
  guardarRutaActiva,
  borrarRutaActiva
} from '../lib/storage.js';
import {
  nubeConfigurada,
  subirReporte,
  encolarPendiente,
  subirPendientes,
  subirPosicion,
  leerRastroNativo
} from '../lib/nube.js';
import { compartirGPX } from '../lib/gpx.js';
import { iniciarGPS, esApk } from '../lib/gps.js';

// Un punto de la ruta cuenta como recorrido si el GPS pasó a menos de esto.
const RADIO_CUBIERTO_M = 30;

function hashSimple(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Agrupa tramos consecutivos de la ruta por nombre de calle para la lista.
// Guarda los índices de los tramos para calcular el avance por calle.
function agruparCalles(ruta) {
  const grupos = [];
  ruta.forEach((u, i) => {
    const ultimo = grupos[grupos.length - 1];
    if (ultimo && ultimo.nombre === u.name) {
      ultimo.metros += u.length;
      ultimo.idx.push(i);
    } else {
      grupos.push({ nombre: u.name, metros: u.length, idx: [i] });
    }
  });
  return grupos;
}

// % de la ruta cubierto: metros con GPS encima / metros totales.
function calcularPct(ruta, cubierto) {
  let total = 0;
  let hecho = 0;
  ruta.forEach((u, i) => {
    total += u.length;
    const c = cubierto[i];
    hecho += (u.length * c.reduce((s, v) => s + v, 0)) / c.length;
  });
  return total ? Math.round((100 * hecho) / total) : 0;
}

// Rumbo (0 = norte, sentido horario) de a hacia b, para orientar la flecha guía.
function rumbo(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x =
    Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
    Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// Convierte (sentido de marcha, rumbo al objetivo) en una indicación de texto.
function clasificarVuelta(head, brg) {
  const d = ((brg - head + 540) % 360) - 180; // -180..180
  if (Math.abs(d) <= 25) return { icono: '↑', texto: 'Sigue derecho' };
  if (d > 150 || d < -150) return { icono: '↩', texto: 'Date la vuelta' };
  return d > 0
    ? { icono: '↱', texto: 'Vuelta a la derecha' }
    : { icono: '↰', texto: 'Vuelta a la izquierda' };
}

// ¿Esta cuadra ya se considera repartida? (la mayoría de sus puntos cubiertos).
function unidadHecha(cub) {
  if (!cub.length) return true;
  return cub.reduce((a, b) => a + b, 0) / cub.length >= 0.7;
}

// La SIGUIENTE calle a repartir: la primera cuadra sin terminar, buscando hacia
// adelante desde la cuadra más cercana a tu posición. Si una calle está cerrada
// y la rodeas, al alejarte deja de ser la más cercana y la guía salta sola a la
// siguiente alcanzable (no se atora). Devuelve el índice de la cuadra o -1.
function siguienteCalle(ruta, cubierto, p) {
  const n = ruta.length;
  let i0 = 0, d0 = Infinity;
  for (let ui = 0; ui < n; ui++) {
    for (const c of ruta[ui].coords) {
      const d = haversine(p, c);
      if (d < d0) { d0 = d; i0 = ui; }
    }
  }
  for (let k = 0; k < n; k++) {
    const ui = (i0 + k) % n;
    if (!unidadHecha(cubierto[ui])) return ui;
  }
  return -1;
}

// Punto de la cuadra `u` más cercano a `p` (a dónde apunta la flecha).
function puntoMasCercano(u, p) {
  let pt = u.coords[0], dd = Infinity;
  for (const c of u.coords) {
    const d = haversine(p, c);
    if (d < dd) { dd = d; pt = c; }
  }
  return { punto: pt, dist: dd };
}

// Punto a `dist` metros de `p` con rumbo `brg` (para encuadrar "adelante de ti").
function destino(p, brg, dist) {
  const R = 6371000;
  const br = (brg * Math.PI) / 180;
  const la1 = (p[0] * Math.PI) / 180;
  const lo1 = (p[1] * Math.PI) / 180;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(dist / R) + Math.cos(la1) * Math.sin(dist / R) * Math.cos(br)
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(br) * Math.sin(dist / R) * Math.cos(la1),
      Math.cos(dist / R) - Math.sin(la1) * Math.sin(la2)
    );
  return [(la2 * 180) / Math.PI, (lo2 * 180) / Math.PI];
}

// Trozos consecutivos de `coords` donde la máscara coincide con `valor`. Sirve
// para iluminar lo ya hecho poquito a poquito (punto por punto, no de golpe).
function trozosPorMascara(coords, mask, valor) {
  const out = [];
  let run = [];
  for (let j = 0; j < coords.length; j++) {
    if ((mask[j] === 1) === valor) {
      run.push(coords[j]);
    } else {
      if (run.length > 1) out.push(run);
      run = [];
    }
  }
  if (run.length > 1) out.push(run);
  return out;
}

// Avanza `metros` desde a hacia b (para poner la flecha justo delante de ti).
function avanzar(a, b, metros) {
  const d = haversine(a, b);
  if (d < 1e-6) return b;
  const t = Math.min(1, metros / d);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export default function Brigadista({ params }) {
  const mapaRef = useRef(null);
  const map = useMap(mapaRef, { rotar: true });
  const capaRuta = useRef(null);
  const capaProgreso = useRef(null);
  const capaGps = useRef(null);
  const capaTrack = useRef(null);
  const detenerGps = useRef(null); // función que apaga la fuente de GPS activa
  const track = useRef([]);
  const wakeLock = useRef(null);
  const ultimaPosSubida = useRef(0);
  const rutaRef = useRef(null);
  const posActual = useRef(null); // último punto GPS
  const modoVistaRef = useRef('territorio'); // espejo de modoVista para el GPS
  // cubierto[i][j] = 1 si el GPS ya pasó cerca del punto j del tramo i.
  const cubierto = useRef([]);

  // La actividad separa el avance de visitas distintas a la misma colonia
  // (folletos hoy vs. calendarios en dos semanas: cada una empieza de cero).
  const actNorm = (params.actividad || 'Reparto')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  const claveRuta = `${params.col || 'poly' + hashSimple(params.poly || '')}_${params.nEquipos}_${params.equipo}_${actNorm}`;

  const [fase, setFase] = useState('cargando'); // cargando | listo | formulario | terminado | error
  const [error, setError] = useState('');
  const [miRuta, setMiRuta] = useState(null);
  const [otras, setOtras] = useState([]);
  const [encuentro, setEncuentro] = useState(null);
  const [calles, setCalles] = useState([]);
  const [pct, setPct] = useState(0);
  const [gpsActivo, setGpsActivo] = useState(false);
  const [gpsError, setGpsError] = useState('');
  // true si la última vez el GPS se quedó activo y nunca se apagó a mano
  // (dentro del APK: seguramente quitaron la app de Recientes a medio
  // camino, lo que mata el registro de golpe — ver lib/gps.js).
  const [interrumpido, setInterrumpido] = useState(false);
  // 'territorio' = ves toda tu zona · 'ruta' = vista guiada que te sigue.
  const [modoVista, setModoVista] = useState('territorio');
  const [guia, setGuia] = useState(null); // indicación del letrero al caminar
  const [entregados, setEntregados] = useState('');
  const [notas, setNotas] = useState('');
  const [resumen, setResumen] = useState('');
  const [reporteFinal, setReporteFinal] = useState(null);
  // '' | 'subiendo' | 'ok' | 'pendiente' — estado del envío a la nube
  const [estadoNube, setEstadoNube] = useState('');

  const color = TEAM_COLORS[(params.equipo - 1) % TEAM_COLORS.length];

  // --- carga inicial: recalcula la misma división que vio el coordinador ---
  useEffect(() => {
    // Si quedó algún reporte sin subir (terminó sin señal), se reintenta ahora.
    subirPendientes();
    (async () => {
      try {
        let rings;
        if (params.col) {
          rings = await ringsPorClave(params.col);
          if (!rings) throw new Error('No se encontró la colonia con clave ' + params.col);
        } else if (params.poly) {
          rings = [decodificarPoly(params.poly)];
        } else {
          throw new Error('El link no incluye la colonia.');
        }
        const ways = await obtenerCalles(rings);
        const units = buildUnits(ways, rings);
        if (units.length === 0) throw new Error('No hay calles dentro del área.');
        const inicio = puntoDeEncuentro(units);
        const grupos = partition(units, params.nEquipos);
        if (params.equipo < 1 || params.equipo > grupos.length) {
          throw new Error('Número de equipo inválido para esta colonia.');
        }
        const rutas = grupos.map((g) => orderRoute(g, inicio));
        const mia = rutas[params.equipo - 1];
        rutaRef.current = mia;

        // Restaura el avance guardado (sobrevive si se recarga la página).
        const prog = cargarProgreso(claveRuta);
        if (Array.isArray(prog.track)) track.current = prog.track;
        if (prog.gpsActivo) setInterrumpido(true);
        cubierto.current = mia.map((u, ui) => {
          const c = Array.isArray(prog.cubierto) ? prog.cubierto[ui] : null;
          return Array.isArray(c) && c.length === u.coords.length
            ? c
            : new Array(u.coords.length).fill(0);
        });

        // Si el GPS nativo siguió mandando puntos mientras la app estaba
        // cerrada (ver lib/gps.js y netlify/functions/gps-relay), se
        // rellenan aquí el trazo y las calles cubiertas con lo que se
        // perdió, antes de mostrar la ruta.
        if (nubeConfigurada()) {
          try {
            const nuevos = await leerRastroNativo(claveRuta, prog.ultimoNativo);
            if (nuevos.length > 0) {
              let ultimoCreado = prog.ultimoNativo || null;
              nuevos.forEach((row) => {
                const p = [row.lat, row.lng];
                const ultimo = track.current[track.current.length - 1];
                if (!ultimo || haversine(ultimo, p) > 15) track.current.push(p);
                mia.forEach((u, ui) => {
                  const c = cubierto.current[ui];
                  for (let j = 0; j < u.coords.length; j++) {
                    if (!c[j] && haversine(p, u.coords[j]) < RADIO_CUBIERTO_M) c[j] = 1;
                  }
                });
                ultimoCreado = row.creado;
              });
              guardarProgreso(claveRuta, {
                track: track.current,
                cubierto: cubierto.current,
                gpsActivo: prog.gpsActivo || false,
                ultimoNativo: ultimoCreado
              });
            }
          } catch {
            /* si falla, el brigadista sigue con lo que ya tenía guardado localmente */
          }
        }

        // Se recuerda para volver aquí si Android reconstruye la pantalla
        // desde cero (ver App.jsx); se borra al terminar el recorrido.
        guardarRutaActiva(params);

        setEncuentro(inicio);
        setMiRuta(mia);
        setOtras(rutas.filter((_, i) => i !== params.equipo - 1));
        setCalles(agruparCalles(mia));
        setPct(calcularPct(mia, cubierto.current));
        setFase('listo');
      } catch (err) {
        setError(err.message);
        setFase('error');
      }
    })();
    return () => {
      if (detenerGps.current) detenerGps.current();
    };
  }, []);

  // --- dibujar ruta -----------------------------------------------------
  useEffect(() => {
    if (!map || !miRuta) return;
    dibujarBase();
    dibujarTrack(); // recorrido previo restaurado (si recargó a media caminata)
    pintarProgreso();
  }, [map, miRuta]);

  // --- cámara según el modo: 'territorio' encuadra toda la zona; 'ruta' es la
  //     vista guiada que te sigue (acercada y, al caminar, rotando como Waze).
  useEffect(() => {
    modoVistaRef.current = modoVista;
    if (!map || !miRuta) return;
    dibujarBase();
    pintarProgreso();
    if (modoVista === 'ruta') {
      map.invalidateSize(); // el tamaño pudo cambiar al aparecer el letrero
      if (posActual.current) seguirCamara(posActual.current);
      else map.setView(miRuta[0].coords[0], 17);
    } else {
      if (map.setBearing) map.setBearing(0); // norte arriba en la vista de todo
      const todos = miRuta.flatMap((u) => u.coords);
      map.fitBounds(ringsBounds([todos]), { padding: [20, 20] });
    }
  }, [modoVista, map, miRuta]);

  function cambiarModo(m) {
    modoVistaRef.current = m;
    setModoVista(m);
  }

  // Base del mapa. En 'territorio' se ve TODA la ruta (para planear y rodear
  // calles cerradas); en 'ruta' la base queda limpia: solo se verá lo gris (ya
  // hecho) y la calle siguiente resaltada (las pinta pintarProgreso).
  function dibujarBase() {
    if (!map || !miRuta) return;
    if (capaRuta.current) capaRuta.current.remove();
    const g = L.layerGroup().addTo(map);
    if (modoVistaRef.current === 'territorio') {
      otras.forEach((r) =>
        r.forEach((u) =>
          L.polyline(u.coords, { color: '#999', weight: 2, opacity: 0.3 }).addTo(g)
        )
      );
      const pasos = recorridoContinuo(miRuta);
      pasos.forEach((p) =>
        p.tipo === 'cubrir'
          ? L.polyline(p.coords, { color, weight: 6, opacity: 0.5 }).addTo(g)
          : L.polyline(p.coords, { color, weight: 3, opacity: 0.55, dashArray: '2 9' }).addTo(g)
      );
      const linea = pasos.flatMap((p) => p.coords);
      flechasDeRecorrido(linea, color).addTo(g);
      marcadorInicio(miRuta[0].coords[0], params.equipo, color).addTo(g);
      if (encuentro) marcadorEncuentro(encuentro).addTo(g);
      const fin = linea[linea.length - 1];
      if (fin) marcadorFin(fin).addTo(g);
    }
    capaRuta.current = g;
  }

  // Ilumina el avance y —en vista guiada— resalta SOLO la calle siguiente.
  function pintarProgreso() {
    if (!map || !rutaRef.current) return;
    if (capaProgreso.current) capaProgreso.current.remove();
    const g = L.layerGroup().addTo(map);
    const guiado = modoVistaRef.current === 'ruta';

    // En vista guiada, marca DOS calles: el camino para llegar (punteado) y la
    // calle que sigue a repartir (sólida y gruesa).
    let objUi = -1;
    if (guiado && posActual.current) {
      objUi = siguienteCalle(rutaRef.current, cubierto.current, posActual.current);
      if (objUi >= 0) {
        const u = rutaRef.current[objUi];
        // 1) Camino para llegar: "ve por aquí" (punteado, desde tu posición hasta
        //    donde empieza la calle a repartir). Si está pegada, va directo a su esquina.
        const camino = caminoACalle(rutaRef.current, posActual.current, objUi);
        let wayPts;
        if (camino.length) {
          wayPts = [posActual.current, ...camino.flat()];
        } else {
          const e1 = u.coords[0];
          const e2 = u.coords[u.coords.length - 1];
          const esquina =
            haversine(posActual.current, e1) <= haversine(posActual.current, e2) ? e1 : e2;
          wayPts = [posActual.current, esquina];
        }
        if (wayPts.length > 1) {
          L.polyline(wayPts, {
            color,
            weight: 5,
            opacity: 0.85,
            dashArray: '3 9',
            lineCap: 'round'
          }).addTo(g);
        }
        // 2) Calle a repartir: "esta repartes" (sólida con contorno blanco).
        L.polyline(u.coords, { color: '#fff', weight: 13, opacity: 0.95 }).addTo(g);
        L.polyline(u.coords, { color, weight: 8, opacity: 1 }).addTo(g);
      }
    }
    // Lo ya recorrido, gris, punto por punto. Va ENCIMA para que la calle
    // siguiente se vaya poniendo gris conforme la caminas.
    rutaRef.current.forEach((u, ui) => {
      for (const run of trozosPorMascara(u.coords, cubierto.current[ui], true)) {
        L.polyline(run, { color: '#9aa3ab', weight: guiado ? 8 : 6, opacity: 0.95 }).addTo(g);
      }
    });
    // Flecha grande hacia la calle siguiente. Solo cuando el mapa NO rota (modo
    // de respaldo): con el mapa girado hacia adelante, la orientación ya guía y
    // una flecha encima confundiría.
    if (guiado && objUi >= 0 && posActual.current && !map.setBearing) {
      const { punto } = puntoMasCercano(rutaRef.current[objUi], posActual.current);
      const ang = rumbo(posActual.current, punto);
      L.marker(avanzar(posActual.current, punto, 14), {
        interactive: false,
        keyboard: false,
        zIndexOffset: 1100,
        icon: L.divIcon({
          className: 'flecha-grande',
          html: `<div style="transform:rotate(${ang}deg);color:${color}">▲</div>`,
          iconSize: [40, 40],
          iconAnchor: [20, 20]
        })
      }).addTo(g);
    }
    capaProgreso.current = g;
  }

  // Cámara estilo Waze: rota el mapa hacia donde caminas y te coloca en el
  // tercio inferior para ver lo que viene adelante.
  function seguirCamara(p) {
    if (!map) return;
    const z = Math.max(map.getZoom() || 0, 17);
    const head = rumboReciente();
    if (map.setBearing && head != null) {
      map.setBearing(-head); // gira el mapa para que "adelante" quede arriba
      map.setView(destino(p, head, 70), z, { animate: true, duration: 0.6 });
    } else {
      map.setView(p, z, { animate: true, duration: 0.6 });
    }
  }

  // Rumbo reciente de la caminata (un punto ~18 m atrás), para rotar y decir la vuelta.
  function rumboReciente() {
    const t = track.current;
    if (t.length < 2) return null;
    const fin = t[t.length - 1];
    for (let i = t.length - 2; i >= 0; i--) {
      if (haversine(t[i], fin) >= 18) return rumbo(t[i], fin);
    }
    return rumbo(t[0], fin);
  }

  // Actualiza el letrero (calle siguiente, distancia y vuelta). La vuelta se
  // calcula con el PRIMER paso del camino para llegar (no la línea recta).
  function actualizarGuia(p) {
    if (!rutaRef.current) return;
    const objUi = siguienteCalle(rutaRef.current, cubierto.current, p);
    if (objUi < 0) { setGuia({ fin: true }); return; }
    const u = rutaRef.current[objUi];
    const { punto, dist } = puntoMasCercano(u, p);
    const wayPts = [...caminoACalle(rutaRef.current, p, objUi).flat(), punto];
    let rumboObjetivo = rumbo(p, punto);
    for (const q of wayPts) {
      if (haversine(p, q) >= 12) { rumboObjetivo = rumbo(p, q); break; }
    }
    const head = rumboReciente();
    setGuia({
      calle: u.name,
      dist: Math.round(dist),
      vuelta: head == null ? null : clasificarVuelta(head, rumboObjetivo)
    });
  }

  // Dibuja el rastro real partido en segmentos: donde hubo un hueco grande
  // (teléfono bloqueado) no se pinta línea recta falsa.
  function dibujarTrack() {
    if (!map) return;
    if (capaTrack.current) capaTrack.current.remove();
    const segs = partirTrayectoria(track.current);
    if (segs.length === 0) return;
    const g = L.layerGroup().addTo(map);
    segs.forEach((s) =>
      L.polyline(s, { color: '#222', weight: 2, dashArray: '4 5' }).addTo(g)
    );
    capaTrack.current = g;
  }

  // Mientras el GPS está activo, se le pide al teléfono no apagar la pantalla:
  // con la pantalla bloqueada el navegador congela la página y se pierde el rastro.
  useEffect(() => {
    if (!gpsActivo) return;
    async function pedirPantallaActiva() {
      try {
        if ('wakeLock' in navigator) {
          wakeLock.current = await navigator.wakeLock.request('screen');
        }
      } catch {
        /* batería baja o navegador sin soporte: la app sigue normal */
      }
    }
    pedirPantallaActiva();
    // Si el usuario bloqueó de todos modos, al volver se vuelve a pedir.
    const alVolver = () => {
      if (document.visibilityState === 'visible') pedirPantallaActiva();
    };
    document.addEventListener('visibilitychange', alVolver);
    return () => {
      document.removeEventListener('visibilitychange', alVolver);
      if (wakeLock.current) {
        wakeLock.current.release().catch(() => {});
        wakeLock.current = null;
      }
    };
  }, [gpsActivo]);

  // --- GPS ----------------------------------------------------------------
  // La fuente real vive en lib/gps.js: watchPosition en el navegador, plugin
  // de segundo plano dentro del APK (sigue registrando con pantalla apagada).
  function activarGPS() {
    setGpsError('');
    setInterrumpido(false);
    cambiarModo('ruta'); // al empezar a caminar, entra a la vista guiada
    // Se marca "activo" de una vez (no solo cuando se detecta movimiento o
    // avance): si el teléfono está quieto un momento y ahí se cierra la app,
    // igual debe notarse al reabrir que el registro se cortó a medio camino.
    guardarProgreso(claveRuta, {
      track: track.current,
      cubierto: cubierto.current,
      gpsActivo: true
    });
    detenerGps.current = iniciarGPS(
      claveRuta,
      (punto) => {
        const p = [punto.lat, punto.lng];
        setGpsActivo(true);

        // guarda el recorrido real (un punto cada ~15 m)
        const ultimo = track.current[track.current.length - 1];
        const seMovio = !ultimo || haversine(ultimo, p) > 15;
        if (seMovio) track.current.push(p);

        // marca como recorridos los puntos de la ruta cercanos al GPS
        let cambio = false;
        if (rutaRef.current) {
          rutaRef.current.forEach((u, ui) => {
            const c = cubierto.current[ui];
            for (let j = 0; j < u.coords.length; j++) {
              if (!c[j] && haversine(p, u.coords[j]) < RADIO_CUBIERTO_M) {
                c[j] = 1;
                cambio = true;
              }
            }
          });
        }
        if (cambio) setPct(calcularPct(rutaRef.current, cubierto.current));
        if (cambio || seMovio) {
          guardarProgreso(claveRuta, {
            track: track.current,
            cubierto: cubierto.current,
            // Si la app se cierra a medio camino (p. ej. la quitan de
            // Recientes), este valor se queda en "true": al reabrir se
            // avisa que el registro se cortó (ver useEffect de arriba).
            gpsActivo: true
          });
        }

        // Reporta la posición al coordinador cada ~25 s (pesa ~2 KB).
        if (Date.now() - ultimaPosSubida.current > 25000) {
          ultimaPosSubida.current = Date.now();
          subirPosicion({
            id: claveRuta,
            colonia: params.nombre,
            col: params.col || null,
            equipo: params.equipo,
            n_equipos: params.nEquipos,
            actividad: params.actividad,
            campana: params.campana || null,
            brigada: params.brigada || null,
            lat: p[0],
            lng: p[1],
            pct: rutaRef.current ? calcularPct(rutaRef.current, cubierto.current) : 0
          });
        }

        // Ilumina el avance, actualiza el letrero y la flecha grande.
        posActual.current = p;
        pintarProgreso();
        actualizarGuia(p);

        if (!map) return;
        // En vista guiada, la cámara te sigue y rota hacia donde caminas.
        if (modoVistaRef.current === 'ruta') seguirCamara(p);
        if (capaGps.current) capaGps.current.remove();
        const g = L.layerGroup().addTo(map);
        L.circle(p, { radius: punto.precision, color: '#1d6fd1', weight: 1, fillOpacity: 0.1 }).addTo(g);
        L.circleMarker(p, { radius: 8, color: '#fff', weight: 2, fillColor: '#1d6fd1', fillOpacity: 1 }).addTo(g);
        capaGps.current = g;
        if (seMovio) dibujarTrack();
      },
      (mensaje) => {
        setGpsError(mensaje);
        setGpsActivo(false);
      }
    );
  }

  function centrarEnMi() {
    const ultimo = posActual.current || track.current[track.current.length - 1];
    if (!ultimo || !map) return;
    map.invalidateSize();
    if (modoVistaRef.current === 'ruta') seguirCamara(ultimo);
    else map.setView(ultimo, 17);
  }

  // --- avance por calle (automático, según el GPS) -------------------------
  function pctCalle(grupo) {
    if (!rutaRef.current || !grupo.metros) return 0;
    let m = 0;
    for (const ui of grupo.idx) {
      const u = rutaRef.current[ui];
      const c = cubierto.current[ui];
      m += (u.length * c.reduce((s, v) => s + v, 0)) / c.length;
    }
    return (100 * m) / grupo.metros;
  }

  const totalKm = miRuta ? miRuta.reduce((s, u) => s + u.length, 0) / 1000 : 0;

  // --- cierre ---------------------------------------------------------------
  function terminarRecorrido() {
    // Se apaga el GPS y se libera la pantalla: el recorrido ya terminó.
    if (detenerGps.current) {
      detenerGps.current();
      detenerGps.current = null;
    }
    setGpsActivo(false);

    const n = parseInt(entregados, 10) || 0;
    const reporte = {
      fecha: new Date().toISOString(),
      colonia: params.nombre,
      col: params.col || null,
      poly: params.poly || null,
      equipo: params.equipo,
      nEquipos: params.nEquipos,
      actividad: params.actividad,
      campana: params.campana || null,
      brigada: params.brigada || null,
      km: Math.round(totalKm * 10) / 10,
      porcentaje: pct,
      entregados: n,
      notas: notas.trim(),
      recorridoReal: track.current.map((q) => [+q[0].toFixed(5), +q[1].toFixed(5)])
    };
    guardarReporte(reporte);
    limpiarProgreso(claveRuta);
    borrarRutaActiva();

    // Sube el reporte a la nube; sin señal, queda en cola y se reintenta solo.
    if (nubeConfigurada()) {
      setEstadoNube('subiendo');
      subirReporte(reporte).then((ok) => {
        if (ok) {
          setEstadoNube('ok');
        } else {
          encolarPendiente(reporte);
          setEstadoNube('pendiente');
        }
      });
    }

    const texto =
      `🗺️ GeoBrigada – Reporte de recorrido\n` +
      (params.campana ? `Campaña: ${params.campana}\n` : '') +
      `Colonia: ${params.nombre}\n` +
      `Actividad: ${params.actividad}\n` +
      (params.brigada ? `Brigada: ${params.brigada}\n` : '') +
      `Equipo: ${params.equipo} de ${params.nEquipos}\n` +
      `Fecha: ${new Date().toLocaleString('es-MX')}\n` +
      `Ruta recorrida: ${pct}% (${totalKm.toFixed(1)} km asignados)\n` +
      `Objetos entregados: ${n}` +
      (notas.trim() ? `\nNotas: ${notas.trim()}` : '');
    setResumen(texto);
    setReporteFinal(reporte);
    setFase('terminado');
  }

  async function copiarResumen() {
    try {
      await navigator.clipboard.writeText(resumen);
    } catch {
      window.prompt('Copia el resumen:', resumen);
    }
  }

  // Comparte el recorrido como archivo: el coordinador lo importa en la
  // pestaña Historial y ve la trayectoria de cada equipo en el mapa.
  async function compartirArchivo() {
    const json = JSON.stringify(reporteFinal);
    const nombre = `geobrigada_eq${params.equipo}_${(params.nombre || 'colonia')
      .replace(/\s+/g, '_')
      .toLowerCase()}.json`;
    const file = new File([json], nombre, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Recorrido GeoBrigada' });
        return;
      } catch {
        /* compartir cancelado: cae a la descarga */
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = nombre;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // --- render ---------------------------------------------------------------
  return (
    <div className="app">
      <header className="encabezado">
        <h1>🗺️ {params.nombre}</h1>
        <span className="sub">
          {params.campana ? params.campana + ' · ' : ''}
          {params.actividad}
          {params.brigada ? ' · ' + params.brigada : ''} · Equipo {params.equipo} de{' '}
          {params.nEquipos}
        </span>
      </header>
      <div className="contenido">
        <div className="mapa" ref={mapaRef} />
        <div className="panel">
          {fase === 'cargando' && (
            <>
              <p>Cargando tu ruta…</p>
              <p className="nota">
                La primera vez se descargan las calles de tu colonia; puede tardar
                hasta un minuto. Después queda guardado en tu teléfono.
              </p>
            </>
          )}
          {fase === 'error' && <div className="error">{error}</div>}

          {(fase === 'listo' || fase === 'formulario') && miRuta && (
            <>
              {modoVista === 'ruta' && gpsActivo && guia && (
                <div className={'guia-banner' + (guia.fin ? ' fin' : '')}>
                  <span className="icono">
                    {guia.fin ? '✅' : guia.vuelta ? guia.vuelta.icono : '🎯'}
                  </span>
                  <span>
                    <span className="texto">
                      {guia.fin
                        ? '¡Terminaste tu ruta!'
                        : guia.vuelta
                        ? guia.vuelta.texto
                        : 'Ve a tu siguiente calle'}
                    </span>
                    <br />
                    <span className="detalle">
                      {guia.fin
                        ? 'Ya cubriste todo lo posible.'
                        : `${guia.calle} · a ${guia.dist} m`}
                    </span>
                  </span>
                </div>
              )}

              {interrumpido && !gpsActivo && (
                <div className="aviso">
                  ⚠️ Tu registro se cortó (seguramente cerraste la app). Tu
                  avance no se perdió — toca «Activar mi GPS» para seguir.
                </div>
              )}
              <div className="fila">
                <button
                  className={gpsActivo ? 'boton exito' : 'boton primario'}
                  onClick={gpsActivo ? centrarEnMi : activarGPS}
                >
                  {gpsActivo
                    ? '📍 Centrar en mí'
                    : interrumpido
                    ? '📡 Reanudar mi GPS'
                    : '📡 Activar mi GPS'}
                </button>
                <span style={{ fontSize: '0.85rem', color: '#555' }}>
                  {totalKm.toFixed(1)} km · {calles.length} calles
                </span>
              </div>
              <div className="fila">
                <button
                  className="boton suave mini"
                  onClick={() => cambiarModo(modoVista === 'ruta' ? 'territorio' : 'ruta')}
                >
                  {modoVista === 'ruta'
                    ? '🗺️ Ver todo mi territorio'
                    : '🧭 Volver a la vista guiada'}
                </button>
              </div>
              {gpsError && <div className="error">{gpsError}</div>}
              {gpsActivo && esApk && (
                <p className="nota">
                  🔆 Puedes apagar la pantalla, seguirá registrando.{' '}
                  <strong>No quites GeoBrigada de Recientes</strong> (el
                  cuadrito de apps abiertas): eso sí corta el registro.
                </p>
              )}
              {gpsActivo && !esApk && (
                <p className="nota">
                  🔆 La pantalla se mantendrá encendida mientras recorres, para no
                  perder tu rastro. <strong>No bloquees el teléfono</strong>: si lo
                  bloqueas, el GPS se pausa hasta que lo desbloquees.
                </p>
              )}

              <h3>Porcentaje de la ruta recorrido</h3>
              <div className="fila" style={{ alignItems: 'center' }}>
                <span className="pct-grande" style={{ color }}>
                  {pct}%
                </span>
                <div className="progreso-barra" style={{ flex: 1, margin: 0 }}>
                  <div style={{ width: pct + '%' }} />
                </div>
              </div>
              <p className="nota">
                Se calcula solo con tu GPS: camina las calles de tu color y el
                porcentaje sube automáticamente.
              </p>

              <p className="nota">
                👉 El mapa gira hacia donde caminas. La línea <strong>punteada</strong>
                es el camino para llegar; la <strong>sólida y gruesa</strong> es la
                calle que toca repartir. Lo que terminas se pone <strong>gris</strong>{' '}
                solo y se enciende la que sigue. Si una calle está cerrada o es
                privada, toca <strong>«Ver todo mi territorio»</strong> para rodearla.
              </p>

              <h3>Tus calles</h3>
              <ul className="lista-calles">
                {calles.map((c, i) => {
                  const pc = pctCalle(c);
                  return (
                    <li key={i}>
                      <span className={pc >= 70 ? 'hecha' : ''}>
                        {i + 1}. {c.nombre}
                      </span>
                      <span className="km">
                        {(c.metros / 1000).toFixed(2)} km ·{' '}
                        {pc >= 70 ? '✓' : Math.round(pc) + '%'}
                      </span>
                    </li>
                  );
                })}
              </ul>

              {fase === 'listo' && (
                <div className="fila" style={{ marginTop: 12 }}>
                  <button className="boton primario" onClick={() => setFase('formulario')}>
                    ✓ Terminé mi recorrido
                  </button>
                </div>
              )}

              {fase === 'formulario' && (
                <>
                  <h3>¿Cuántos objetos entregaste?</h3>
                  <div className="fila">
                    <input
                      type="number"
                      autoComplete="off"
                      min="0"
                      value={entregados}
                      onChange={(e) => setEntregados(e.target.value)}
                    />
                    <span style={{ fontSize: '0.85rem', color: '#555' }}>
                      objetos entregados
                    </span>
                  </div>
                  <h3>Notas (opcional)</h3>
                  <textarea
                    rows="2"
                    value={notas}
                    onChange={(e) => setNotas(e.target.value)}
                  />
                  <div className="fila" style={{ marginTop: 10 }}>
                    <button className="boton exito" onClick={terminarRecorrido}>
                      Guardar reporte
                    </button>
                    <button className="boton suave" onClick={() => setFase('listo')}>
                      Volver
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {fase === 'terminado' && (
            <>
              <h2>✅ ¡Recorrido registrado!</h2>

              {estadoNube === 'subiendo' && (
                <div className="aviso">☁️ Enviando tu recorrido al coordinador…</div>
              )}
              {estadoNube === 'ok' && (
                <div className="aviso" style={{ background: '#f0f6ee', borderColor: '#cde3c8' }}>
                  ☁️ ¡Listo! Tu recorrido y tu reporte ya le llegaron al coordinador
                  automáticamente. No tienes que hacer nada más.
                </div>
              )}
              {estadoNube === 'pendiente' && (
                <div className="aviso">
                  📶 Ahora mismo no hay señal: tu recorrido se enviará solo en cuanto
                  el teléfono recupere internet (puedes cerrar la página; al volver a
                  abrir tu link se envía).
                </div>
              )}

              <div className="resumen-final">{resumen}</div>

              <div className="fila" style={{ marginTop: 10 }}>
                <button
                  className="boton primario"
                  onClick={() => compartirGPX(reporteFinal)}
                  disabled={!reporteFinal || (reporteFinal.recorridoReal || []).length < 2}
                >
                  📍 Enviar recorrido (.gpx)
                </button>
              </div>
              <div className="aviso">
                Manda el archivo <strong>.gpx</strong> con tu recorrido por WhatsApp, junto
                con los objetos entregados (botón de abajo). Es el mismo formato de siempre.
              </div>

              <div className="fila" style={{ marginTop: 10 }}>
                <button className="boton suave" onClick={copiarResumen}>
                  Copiar datos
                </button>
                <button
                  className="boton exito"
                  onClick={() =>
                    window.open('https://wa.me/?text=' + encodeURIComponent(resumen), '_blank')
                  }
                >
                  Enviar datos por WhatsApp
                </button>
              </div>
              {estadoNube !== 'ok' && estadoNube !== 'subiendo' && (
                <>
                  <div className="fila">
                    <button className="boton primario" onClick={compartirArchivo}>
                      📤 Enviar mi trayectoria al coordinador
                    </button>
                  </div>
                  <div className="aviso" style={{ marginTop: 10 }}>
                    El botón azul comparte un archivo con tu recorrido GPS. Mándaselo al
                    coordinador (por WhatsApp): él lo importa en la pestaña Historial y ve
                    en el mapa por dónde caminó cada equipo.
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

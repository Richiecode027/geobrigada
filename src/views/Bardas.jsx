import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap } from '../components/useMap.js';
import { iniciarGPS, obtenerPosicionActual } from '../lib/gps.js';
import { registrarAtras } from '../lib/atras.js';
import { comprimirImagen } from '../lib/imagen.js';
import { coordsDeLinkMaps } from '../lib/mapsLink.js';
import { ubicacionAproximada } from '../lib/ubicacion.js';
import { seguirBrujula, pedirPermisoBrujula } from '../lib/brujula.js';
// Solo las etiquetas y la función: la librería pesada (xlsx) se carga dentro
// de descargarCorteBardas, hasta que alguien toca el botón.
import { FILTROS as FILTROS_CORTE, descargarCorteBardas } from '../lib/corteBardas.js';
import {
  cargarBardas,
  bardasPendientes,
  bardaAtendida,
  rutaDeBardasPorCalles,
  largoDeRuta
} from '../lib/bardas.js';
import {
  nubeConfigurada,
  cargarPermisosBardas,
  guardarPermisoBarda,
  anularPermisoBarda,
  cargarBardasNuevas,
  guardarBardaNueva,
  subirFotoBardaNueva,
  cargarReservasBardas,
  reservarBardas,
  liberarReservasBardas
} from '../lib/nube.js';

// Una fila de bardas_nuevas (la sube el equipo desde la app) al mismo formato
// que usa el resto de la vista para una barda del catálogo.
function aBardaCatalogo(n) {
  return {
    id: n.id,
    brigada: null,
    direccion: n.direccion,
    colonia: n.colonia,
    distrito: n.distrito,
    lat: n.lat,
    lng: n.lng,
    foto: n.foto,
    referencia: null
  };
}

const idNuevo = () =>
  'n-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));

// Los cuatro resultados posibles de una visita. El orden es el de los botones.
const ESTADOS = [
  { id: 'con_permiso', etiqueta: '✅ Sí dio permiso', corto: 'Con permiso', color: '#2a9d3a', pin: '✓', boton: 'exito' },
  { id: 'sin_permiso', etiqueta: '❌ No dio permiso', corto: 'Sin permiso', color: '#c1121f', pin: '✕', boton: 'peligro' },
  { id: 'visitado', etiqueta: '🚪 No había nadie', corto: 'Visitado', color: '#7b61c9', pin: '?', boton: 'suave' },
  { id: 'no_habitado', etiqueta: '🏚 Casa sola / abandonada', corto: 'No habitado', color: '#6b7280', pin: '—', boton: 'suave' }
];
const ESTADO_POR_ID = new Map(ESTADOS.map((e) => [e.id, e]));

// Los registros de antes de que existiera `estado` solo traen el booleano.
const estadoDeRegistro = (p) =>
  p?.estado || (p?.permiso === true ? 'con_permiso' : p?.permiso === false ? 'sin_permiso' : null);

const infoEstado = (p) => ESTADO_POR_ID.get(estadoDeRegistro(p)) || null;

// --- la jornada se guarda en el teléfono -------------------------------------
// A varios equipos se les cerró la app a medio recorrido (Android mata la
// pestaña, se acaba la batería, le pican al botón equivocado) y al volver a
// entrar habían perdido su ruta Y sus bardas seguían apartadas a su nombre:
// no las podía tomar nadie, ni ellos. Guardando aquí quién es el equipo y qué
// ruta traía, al reabrir se puede retomar exactamente la misma.
const CLAVE_SESION = 'geobrigada_bardas_sesion';
const HORAS_SESION = 12;

function leerSesion() {
  try {
    const s = JSON.parse(localStorage.getItem(CLAVE_SESION));
    if (!s || !s.guardado) return null;
    // Una sesión de ayer ya no sirve para retomar (pero el nombre del equipo sí).
    if (Date.now() - s.guardado > HORAS_SESION * 3600000) return { equipo: s.equipo };
    return s;
  } catch {
    return null;
  }
}

function guardarSesion(s) {
  try {
    localStorage.setItem(CLAVE_SESION, JSON.stringify({ ...s, guardado: Date.now() }));
  } catch {
    /* sin espacio: solo se pierde poder retomar, la jornada sigue */
  }
}

function borrarSesion() {
  try {
    localStorage.removeItem(CLAVE_SESION);
  } catch {
    /* nada que hacer */
  }
}

// Las fotos del catálogo (Excel) son rutas locales ("bardas-fotos/1.jpg");
// las de bardas agregadas desde la app son URLs completas de Supabase Storage.
const urlFoto = (foto) => (/^https?:/.test(foto) ? foto : import.meta.env.BASE_URL + foto);

const CANTIDAD_SUGERIDA = 10;

function metrosBonito(m) {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

// Quita acentos y mayúsculas para buscar sin que estorben.
const normalizar = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Pin numerado: verde = con permiso, rojo = sin permiso, azul = en la ruta de
// hoy (con su número de orden), gris = pendiente pero fuera de la ruta.
function pinBarda(latlng, texto, color) {
  return L.marker(latlng, {
    icon: L.divIcon({
      className: 'pin-barda',
      html: `<div style="background:${color}">${texto}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    })
  });
}

export default function Bardas() {
  const mapaRef = useRef(null);
  const map = useMap(mapaRef);
  const capaBardas = useRef(null);
  const capaYo = useRef(null);
  const detenerGPS = useRef(null);
  const yaCalculada = useRef(false);

  const [todas, setTodas] = useState([]);
  const [permisos, setPermisos] = useState([]);
  const [reservas, setReservas] = useState([]);
  const [miPos, setMiPos] = useState(null);
  // Grados a los que mira el teléfono (null si no tiene brújula).
  const [rumbo, setRumbo] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [gpsError, setGpsError] = useState('');

  // Lo que quedó guardado la última vez que se usó la app en este teléfono.
  const [sesionInicial] = useState(leerSesion);

  // 'config' = antes de empezar (equipo, cuántas bardas) · 'recorrido' = en camino
  const [fase, setFase] = useState('config');
  const [equipo, setEquipo] = useState(sesionInicial?.equipo || '');
  const [cantidad, setCantidad] = useState(sesionInicial?.cantidad || String(CANTIDAD_SUGERIDA));
  // Recorrido a medias que se puede retomar (se decide al abrir, no antes).
  const [sesionPrevia, setSesionPrevia] = useState(
    sesionInicial?.fase === 'recorrido' && sesionInicial.ruta?.length ? sesionInicial : null
  );
  const [ruta, setRuta] = useState([]);
  const [porCalles, setPorCalles] = useState(false);
  const [calculando, setCalculando] = useState(false);

  // Buscador para marcar una barda que alguien hizo SIN la app.
  const [busqueda, setBusqueda] = useState('');
  // En el teléfono el panel se puede plegar (queda solo el asa) para ver el
  // mapa casi a pantalla completa mientras se camina.
  const [panelPlegado, setPanelPlegado] = useState(false);

  const [registrando, setRegistrando] = useState(null);
  const [form, setForm] = useState({
    estado: null, nombre: '', telefono: '', aCambio: '', notas: '', equipo: ''
  });
  const [guardando, setGuardando] = useState(false);
  const [exportando, setExportando] = useState(false);
  const [filtroCorte, setFiltroCorte] = useState('todo');

  // Agregar una barda que no está en el catálogo (la encontró el equipo en la calle).
  const [agregando, setAgregando] = useState(false);
  const [formNueva, setFormNueva] = useState({
    direccion: '', colonia: '', distrito: '', archivo: null, previewUrl: null
  });
  const [autollenando, setAutollenando] = useState(false);
  const [comoSeDedujo, setComoSeDedujo] = useState('');
  const [posNueva, setPosNueva] = useState(null);
  const [gpsNuevaError, setGpsNuevaError] = useState('');
  const [guardandoNueva, setGuardandoNueva] = useState(false);
  const [linkNueva, setLinkNueva] = useState('');
  const [resolviendoLink, setResolviendoLink] = useState(false);
  const [linkNuevaError, setLinkNuevaError] = useState('');

  // --- carga inicial: catálogo + lo que ya se visitó -----------------------
  useEffect(() => {
    (async () => {
      try {
        const bardas = await cargarBardas();
        let todasConNuevas = bardas;
        if (nubeConfigurada()) {
          try {
            setPermisos(await cargarPermisosBardas());
          } catch {
            setError(
              'No se pudo leer de la nube qué bardas ya se visitaron; se muestran todas como pendientes.'
            );
          }
          try {
            const nuevas = await cargarBardasNuevas();
            todasConNuevas = [...bardas, ...nuevas.map(aBardaCatalogo)];
          } catch {
            /* si falla, se sigue solo con el catálogo del Excel */
          }
          try {
            setReservas(await cargarReservasBardas());
          } catch {
            /* si falla, simplemente no se ven las apartadas de otros equipos */
          }
        }
        setTodas(todasConNuevas);
      } catch (e) {
        setError(e.message);
      }
      setCargando(false);
    })();
    return () => {
      if (detenerGPS.current) detenerGPS.current();
    };
  }, []);

  // Refresco ligero de las reservas: para que si alguien más aparta bardas
  // mientras este equipo sigue viendo el mapa (decidiendo por dónde empezar),
  // el color se ponga al día sin que tenga que recargar la app.
  useEffect(() => {
    if (!nubeConfigurada()) return;
    const id = setInterval(async () => {
      try {
        setReservas(await cargarReservasBardas());
      } catch {
        /* se reintenta en el siguiente ciclo */
      }
    }, 30000);
    return () => clearInterval(id);
  }, []);

  // Solo los registros que de verdad cierran la barda: uno "visitado" de ayer
  // ya no cuenta (esa barda volvió a la lista de pendientes hoy).
  const permisosVigentes = useMemo(() => permisos.filter(bardaAtendida), [permisos]);
  const pendientes = useMemo(() => bardasPendientes(todas, permisos), [todas, permisos]);
  const porEstado = useMemo(() => {
    const cuenta = new Map(ESTADOS.map((e) => [e.id, 0]));
    for (const p of permisosVigentes) {
      const id = estadoDeRegistro(p);
      if (cuenta.has(id)) cuenta.set(id, cuenta.get(id) + 1);
    }
    return cuenta;
  }, [permisosVigentes]);

  // Bardas que otro equipo ya trae en su recorrido (las propias no cuentan:
  // ese color es "azul con número", ya lo distingue el mapa).
  const reservasAjenas = useMemo(() => {
    const miEquipo = equipo.trim();
    const m = new Map();
    for (const r of reservas) {
      if ((r.equipo || '') === miEquipo) continue;
      m.set(String(r.barda_id), r);
    }
    return m;
  }, [reservas, equipo]);

  // Guarda la jornada en el teléfono a cada cambio, para poder retomarla si la
  // app se cierra. Mientras haya una sesión previa esperando respuesta no se
  // toca nada: si no, el arranque en fase 'config' la borraría.
  useEffect(() => {
    if (sesionPrevia) return;
    if (fase === 'recorrido' && ruta.length > 0) {
      guardarSesion({ equipo, cantidad, fase, ruta, porCalles });
    } else if (equipo.trim()) {
      // Aunque no traiga ruta, se recuerda QUIÉN es: así, al reabrir, la app
      // reconoce sus propias reservas en vez de verlas como de otro equipo.
      guardarSesion({ equipo, cantidad, fase: 'config', ruta: [] });
    }
  }, [equipo, cantidad, fase, ruta, porCalles, sesionPrevia]);

  // El GPS lo maneja este efecto y nadie más. Fuera de recorrido va en modo
  // ligero (sin notificación permanente) porque ver dónde estás parado y hacia
  // dónde ves ayuda aunque no traigas ruta; durante el recorrido pasa a modo
  // completo, que sigue registrando con la pantalla apagada.
  useEffect(() => {
    arrancarGPS({ segundoPlano: fase === 'recorrido' });
    return () => {
      if (detenerGPS.current) detenerGPS.current();
      detenerGPS.current = null;
    };
  }, [fase]);

  // Hacia dónde apunta el teléfono, para girar la flecha del mapa.
  useEffect(() => {
    let dejarDeSeguir = () => {};
    let vivo = true;
    pedirPermisoBrujula().then((ok) => {
      if (!vivo || !ok) return;
      dejarDeSeguir = seguirBrujula(setRumbo);
    });
    return () => {
      vivo = false;
      dejarDeSeguir();
    };
  }, []);

  // Renueva la reserva mientras el equipo sigue caminando: dura poco a
  // propósito, así el que desaparece la suelta pronto y el que sigue ahí no
  // la pierde.
  useEffect(() => {
    if (fase !== 'recorrido' || ruta.length === 0) return;
    const id = setInterval(
      () => reservarBardas(ruta.map((b) => b.id), equipo.trim()),
      10 * 60000
    );
    return () => clearInterval(id);
  }, [fase, ruta, equipo]);

  function arrancarGPS({ segundoPlano = true } = {}) {
    if (detenerGPS.current) detenerGPS.current();
    detenerGPS.current = iniciarGPS(
      'bardas',
      (p) => {
        setMiPos([p.lat, p.lng]);
        setGpsError('');
      },
      (msg) => {
        setGpsError(msg);
        setCalculando(false);
      },
      { segundoPlano }
    );
  }

  // Retoma el recorrido tal cual iba: MISMA ruta y mismo orden, sin recalcular
  // (recalcular le cambiaría el camino a media jornada). Solo se quitan las
  // bardas que alguien haya registrado mientras la app estuvo cerrada.
  function retomarRecorrido() {
    const guardada = sesionPrevia;
    setSesionPrevia(null);
    const vivas = new Set(pendientes.map((b) => String(b.id)));
    const rutaViva = guardada.ruta.filter((b) => vivas.has(String(b.id)));
    setRuta(rutaViva);
    setPorCalles(Boolean(guardada.porCalles));
    yaCalculada.current = true;
    setFase('recorrido'); // el efecto del GPS lo pasa solo a modo completo
    setError('');
    setGpsError('');
    reservarBardas(rutaViva.map((b) => b.id), equipo.trim()); // vuelve a apartarlas
  }

  // No quiere retomar: se sueltan esas bardas en el acto para que otro equipo
  // las pueda tomar sin esperar a que venza la reserva.
  function descartarSesionPrevia() {
    if (sesionPrevia?.ruta?.length) {
      liberarReservasBardas(sesionPrevia.ruta.map((b) => b.id));
    }
    borrarSesion();
    setSesionPrevia(null);
  }

  function terminarRecorrido() {
    if (ruta.length > 0) liberarReservasBardas(ruta.map((b) => b.id));
    borrarSesion();
    setFase('config'); // el efecto del GPS regresa solo a modo ligero
    setRuta([]);
  }

  // Botón "atrás" de Android: en vez de cerrar la app, cierra lo que esté
  // abierto. Primero el formulario, luego el recorrido; ya en el inicio, sí
  // deja salir.
  useEffect(() => {
    return registrarAtras(() => {
      if (agregando) {
        cerrarAgregar();
        return true;
      }
      if (registrando) {
        setRegistrando(null);
        return true;
      }
      if (fase === 'recorrido') {
        terminarRecorrido();
        return true;
      }
      return false;
    });
    // `ruta` va en la lista porque terminarRecorrido la usa para soltar las
    // reservas: sin esto se quedaría con una copia vieja.
  }, [agregando, registrando, fase, ruta]);

  // --- agregar una barda que no está en el catálogo -------------------------
  // Si el equipo pega un link de Maps, esa ubicación manda sobre la del GPS
  // (que puede seguir resolviéndose de fondo y llegar después): esta bandera
  // evita que el GPS, al llegar tarde, le gane al link ya elegido a propósito.
  const posDeLinkRef = useRef(false);

  function abrirAgregar() {
    setError('');
    setAgregando(true);
    setFormNueva({ direccion: '', colonia: '', distrito: '', archivo: null, previewUrl: null });
    setPosNueva(null);
    setGpsNuevaError('');
    setLinkNueva('');
    setLinkNuevaError('');
    setComoSeDedujo('');
    posDeLinkRef.current = false;
    ubicacionResuelta.current = null;
    obtenerPosicionActual()
      .then((p) => {
        if (posDeLinkRef.current) return;
        setPosNueva([p.lat, p.lng]);
      })
      .catch((e) => {
        if (posDeLinkRef.current) return;
        setGpsNuevaError(e.message);
      });
  }

  function cerrarAgregar() {
    if (formNueva.previewUrl) URL.revokeObjectURL(formNueva.previewUrl);
    setAgregando(false);
  }

  // Con la ubicación ya se puede saber casi todo: la colonia sale del catálogo
  // del INEGI que trae la app, el distrito se deduce de las bardas ya
  // capturadas y la calle la da OpenStreetMap. Solo se rellena lo que esté
  // vacío: si el equipo ya escribió algo, manda lo que escribió.
  const ubicacionResuelta = useRef(null);
  useEffect(() => {
    if (!agregando || !posNueva) return;
    const clave = posNueva.join(',');
    if (ubicacionResuelta.current === clave) return;
    ubicacionResuelta.current = clave;

    let cancelado = false;
    setAutollenando(true);
    setComoSeDedujo('');
    ubicacionAproximada(posNueva[0], posNueva[1], todas)
      .then((u) => {
        if (cancelado) return;
        setFormNueva((f) => ({
          ...f,
          direccion: f.direccion || u.calle,
          colonia: f.colonia || u.colonia,
          distrito: f.distrito || u.distrito
        }));
        const partes = [];
        if (u.colonia) partes.push('colonia');
        if (u.calle) partes.push('calle');
        if (u.distrito) partes.push(`distrito (según ${u.distritoSegun})`);
        setComoSeDedujo(partes.length ? 'Se llenó sola la ' + partes.join(', ') + '.' : '');
      })
      .finally(() => {
        if (!cancelado) setAutollenando(false);
      });

    return () => {
      cancelado = true;
    };
  }, [agregando, posNueva, todas]);

  async function usarLink() {
    if (!linkNueva.trim()) return;
    setResolviendoLink(true);
    setLinkNuevaError('');
    try {
      const coords = await coordsDeLinkMaps(linkNueva);
      posDeLinkRef.current = true;
      setPosNueva(coords);
      setGpsNuevaError('');
    } catch (e) {
      setLinkNuevaError(e.message);
    }
    setResolviendoLink(false);
  }

  async function guardarNueva() {
    if (!posNueva) return;
    setGuardandoNueva(true);
    const id = idNuevo();
    let foto = null;
    if (formNueva.archivo) {
      try {
        const comprimida = await comprimirImagen(formNueva.archivo);
        foto = await subirFotoBardaNueva(id, comprimida);
      } catch {
        /* si falla la foto, se guarda la barda igual (la ubicación es lo importante) */
      }
    }
    const fila = {
      id,
      direccion: formNueva.direccion.trim() || null,
      colonia: formNueva.colonia.trim() || null,
      distrito: formNueva.distrito.trim() || null,
      lat: posNueva[0],
      lng: posNueva[1],
      foto,
      equipo: equipo.trim() || null
    };
    const ok = await guardarBardaNueva(fila);
    setGuardandoNueva(false);
    if (!ok) {
      setError('No se pudo guardar la barda nueva (¿sin señal?). Intenta de nuevo.');
      return;
    }
    setTodas((t) => [...t, aBardaCatalogo(fila)]);
    if (formNueva.previewUrl) URL.revokeObjectURL(formNueva.previewUrl);
    setAgregando(false);
  }

  // --- empezar el recorrido (solo al tocar el botón) -----------------------
  function iniciarRecorrido() {
    setError('');
    setGpsError('');
    yaCalculada.current = false;
    setCalculando(true);
    setFase('recorrido'); // el efecto del GPS lo pasa solo a modo completo
  }

  // Bardas pendientes que NINGÚN OTRO equipo trae ya en su ruta: se consulta
  // justo antes de calcular, para que dos equipos que arrancan casi al mismo
  // tiempo no acaben con la misma lista.
  async function pendientesLibres() {
    if (!nubeConfigurada()) return pendientes;
    let reservas = [];
    try {
      reservas = await cargarReservasBardas();
    } catch {
      return pendientes; // si falla la consulta, se sigue sin filtrar
    }
    const miEquipo = equipo.trim();
    const apartadas = new Set(
      reservas.filter((r) => (r.equipo || '') !== miEquipo).map((r) => String(r.barda_id))
    );
    return pendientes.filter((b) => !apartadas.has(String(b.id)));
  }

  // Con la primera ubicación se arma la ruta (una sola vez: si se recalculara
  // a cada paso del GPS, el orden cambiaría mientras el equipo camina).
  useEffect(() => {
    if (fase !== 'recorrido' || !miPos || yaCalculada.current || pendientes.length === 0) return;
    yaCalculada.current = true;
    (async () => {
      setCalculando(true);
      const cuantas = Math.max(1, parseInt(cantidad, 10) || CANTIDAD_SUGERIDA);
      const libres = await pendientesLibres();
      const r = await rutaDeBardasPorCalles(miPos, libres, cuantas);
      setRuta(r.ruta);
      setPorCalles(r.porCalles);
      setCalculando(false);
      reservarBardas(r.ruta.map((b) => b.id), equipo.trim());
    })();
  }, [fase, miPos, pendientes, cantidad]);

  // Rehace la ruta con lo que queda pendiente (al registrar o al pedir otras).
  async function recalcular() {
    if (!miPos) return;
    setCalculando(true);
    const cuantas = Math.max(1, parseInt(cantidad, 10) || CANTIDAD_SUGERIDA);
    const libres = await pendientesLibres();
    const r = await rutaDeBardasPorCalles(miPos, libres, cuantas);
    setRuta(r.ruta);
    setPorCalles(r.porCalles);
    setCalculando(false);
    reservarBardas(r.ruta.map((b) => b.id), equipo.trim());
  }

  // --- mapa ----------------------------------------------------------------
  useEffect(() => {
    if (!map) return;
    if (capaBardas.current) capaBardas.current.remove();
    const g = L.layerGroup().addTo(map);
    const porId = new Map(permisosVigentes.map((p) => [String(p.barda_id), p]));
    const enRuta = new Map(ruta.map((b, i) => [String(b.id), i + 1]));

    for (const b of todas) {
      if (b.lat == null) continue;
      const visita = porId.get(String(b.id));
      const orden = enRuta.get(String(b.id));
      const apartada = reservasAjenas.get(String(b.id));
      const info = visita ? infoEstado(visita) : null;
      let color = '#9aa5b1';
      let texto = '';
      if (info) {
        color = info.color;
        texto = info.pin;
      } else if (orden) {
        color = '#1d6fd1';
        texto = String(orden);
      } else if (apartada) {
        color = '#e8a33d';
        texto = '🔒';
      }
      pinBarda([b.lat, b.lng], texto, color)
        .bindTooltip(
          `<strong>${b.direccion || 'Barda ' + b.id}</strong><br>${b.colonia || ''}` +
            (info
              ? `<br>${info.etiqueta}${visita.equipo ? ` · ${visita.equipo}` : ''}`
              : apartada
              ? `<br>🔒 Apartada por ${apartada.equipo || 'otro equipo'}`
              : '')
        )
        .on('click', () => abrirRegistro(b))
        .addTo(g);
    }

    // Trazo del recorrido: por calles reales si se pudieron descargar; si no,
    // línea punteada directa (se avisa en el panel para no engañar).
    if (ruta.length > 0) {
      for (const b of ruta) {
        if (b.trazo && b.trazo.length > 1) {
          L.polyline(b.trazo, { color: '#1d6fd1', weight: 4, opacity: 0.75 }).addTo(g);
        }
      }
      if (!porCalles && miPos) {
        L.polyline([miPos, ...ruta.map((b) => [b.lat, b.lng])], {
          color: '#1d6fd1', weight: 3, opacity: 0.5, dashArray: '6 6'
        }).addTo(g);
      }
    }
    capaBardas.current = g;
  }, [map, todas, permisosVigentes, reservasAjenas, ruta, porCalles, miPos]);

  // Al plegar o desplegar el panel, el mapa cambia de tamaño: hay que avisarle
  // a Leaflet o se queda con el tamaño viejo y los pines salen corridos.
  useEffect(() => {
    if (!map) return;
    const tid = setTimeout(() => map.invalidateSize({ animate: false }), 80);
    return () => clearTimeout(tid);
  }, [map, panelPlegado]);

  // Dónde estás y hacia dónde ves. Con brújula sale una flecha que gira con el
  // teléfono (caminando en una colonia desconocida, "hacia dónde voy" importa
  // más que "dónde estoy"); sin brújula, el punto de siempre.
  useEffect(() => {
    if (!map || !miPos) return;
    if (capaYo.current) capaYo.current.remove();
    const g = L.layerGroup().addTo(map);
    if (rumbo == null) {
      L.circleMarker(miPos, {
        radius: 8, color: '#fff', weight: 2, fillColor: '#1d6fd1', fillOpacity: 1
      }).bindTooltip('Aquí estás tú').addTo(g);
    } else {
      L.marker(miPos, {
        zIndexOffset: 1000,
        icon: L.divIcon({
          className: 'flecha-yo',
          html:
            `<div style="transform:rotate(${rumbo}deg)">` +
            '<svg viewBox="0 0 36 36" width="36" height="36">' +
            '<circle cx="18" cy="18" r="11" fill="#1d6fd1" fill-opacity="0.22"/>' +
            '<path d="M18 4 L26 25 L18 20 L10 25 Z" fill="#1d6fd1" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>' +
            '</svg></div>',
          iconSize: [36, 36],
          iconAnchor: [18, 18]
        })
      })
        .bindTooltip('Aquí estás tú · la punta es hacia donde ves')
        .addTo(g);
    }
    capaYo.current = g;
  }, [map, miPos, rumbo]);

  // Encuadra al armarse la ruta (una vez por ruta nueva).
  const encuadrado = useRef(0);
  useEffect(() => {
    if (!map || ruta.length === 0 || !miPos || encuadrado.current === ruta.length) return;
    map.invalidateSize({ animate: false });
    map.fitBounds(L.latLngBounds([miPos, ...ruta.map((b) => [b.lat, b.lng])]), {
      padding: [40, 40], animate: false
    });
    encuadrado.current = ruta.length;
  }, [map, ruta, miPos]);

  // --- registrar el resultado de la visita ----------------------------------
  function abrirRegistro(b) {
    const previo = permisosVigentes.find((p) => String(p.barda_id) === String(b.id));
    setRegistrando({ ...b, previo: previo || null });
    setForm(
      previo
        ? {
            estado: estadoDeRegistro(previo),
            nombre: previo.nombre || '',
            telefono: previo.telefono || '',
            aCambio: previo.a_cambio || '',
            notas: previo.notas || '',
            // Se respeta el equipo que ya traía: si lo hizo otro, no hay por
            // qué reescribirlo con el de quien está mirando la barda ahora.
            equipo: previo.equipo || equipo
          }
        : { estado: null, nombre: '', telefono: '', aCambio: '', notas: '', equipo }
    );
  }

  async function guardar() {
    if (!registrando || !form.estado) return;
    setGuardando(true);
    const fila = {
      barda_id: String(registrando.id),
      estado: form.estado,
      nombre: form.nombre.trim() || null,
      telefono: form.telefono.trim() || null,
      a_cambio: form.aCambio.trim() || null,
      notas: form.notas.trim() || null,
      equipo: form.equipo.trim() || null,
      lat: miPos ? miPos[0] : null,
      lng: miPos ? miPos[1] : null
    };
    const ok = await guardarPermisoBarda(fila);
    setGuardando(false);
    if (!ok) {
      setError('No se pudo guardar en la nube (¿sin señal?). Intenta de nuevo.');
      return;
    }
    const guardada = { ...fila, anulado: false, actualizado: new Date().toISOString() };
    setPermisos((p) => [...p.filter((x) => String(x.barda_id) !== fila.barda_id), guardada]);
    // Sale de la ruta de hoy; el resto conserva su orden (no se recalcula sola
    // para no cambiarle el camino al equipo a media jornada). Y como ya se
    // atendió, se suelta la reserva: nadie más tiene por qué esperarla.
    setRuta((r) => r.filter((b) => String(b.id) !== fila.barda_id));
    liberarReservasBardas([fila.barda_id]);
    setRegistrando(null);
    setError('');
  }

  async function deshacer(bardaId) {
    if (!window.confirm('¿Quitar este registro? La barda volverá a la lista de pendientes.')) return;
    setGuardando(true);
    const ok = await anularPermisoBarda(String(bardaId));
    setGuardando(false);
    if (!ok) {
      setError('No se pudo deshacer (¿sin señal?). Intenta de nuevo.');
      return;
    }
    setPermisos((p) =>
      p.map((x) => (String(x.barda_id) === String(bardaId) ? { ...x, anulado: true } : x))
    );
    setRegistrando(null);
    setError('');
  }

  // --- corte para la oficina -------------------------------------------------
  async function exportarCorte() {
    setExportando(true);
    setError('');
    try {
      await descargarCorteBardas(todas, permisos, filtroCorte);
    } catch (e) {
      setError('No se pudo armar el Excel del corte. (' + e.message + ')');
    }
    setExportando(false);
  }

  function comoLlegar(b) {
    const destino = b.lat != null
      ? `${b.lat},${b.lng}`
      : encodeURIComponent(`${b.direccion || ''} ${b.colonia || ''} Morelia Michoacán`);
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${destino}`, '_blank');
  }

  // --- buscador para marcar una barda hecha sin la app ---------------------
  const resultados = useMemo(() => {
    const q = normalizar(busqueda).trim();
    if (q.length < 2) return [];
    return todas
      .filter((b) => normalizar(b.direccion + ' ' + b.colonia + ' ' + b.id).includes(q))
      .slice(0, 12);
  }, [busqueda, todas]);

  const estadoDe = (b) => permisosVigentes.find((p) => String(p.barda_id) === String(b.id));

  // --- render ---------------------------------------------------------------
  return (
    <div className="contenido">
      <div className="mapa" ref={mapaRef} />
      <div className={'panel' + (panelPlegado ? ' plegado' : '')}>
        {/* Asa (solo en el teléfono): pliega el panel para ver el mapa grande */}
        <button
          type="button"
          className="asa-panel"
          onClick={() => setPanelPlegado(!panelPlegado)}
        >
          <span className="asa-barrita" />
          {panelPlegado ? '▲ Mostrar panel' : '▼ Ocultar panel'}
        </button>
        <h2>Bardas por pedir permiso</h2>

        {cargando && <p>Cargando bardas…</p>}
        {error && <div className="error">{error}</div>}
        {gpsError && <div className="error">{gpsError}</div>}

        {!cargando && (
          <p style={{ fontSize: '0.9rem' }}>
            <strong>{pendientes.length}</strong> pendientes
            {ESTADOS.map((e) =>
              porEstado.get(e.id) ? (
                <span key={e.id}>
                  {' · '}
                  <strong>{porEstado.get(e.id)}</strong> {e.corto.toLowerCase()}
                </span>
              ) : null
            )}
            {reservasAjenas.size > 0 && (
              <>
                {' · '}
                <strong>{reservasAjenas.size}</strong> 🔒 apartadas por otro equipo
              </>
            )}
          </p>
        )}

        {/* ---------- ANTES DE EMPEZAR ---------- */}
        {/* ---------- RETOMAR UN RECORRIDO QUE SE QUEDÓ A MEDIAS ---------- */}
        {!cargando && sesionPrevia && (
          <div className="tarjeta-equipo" style={{ borderLeftColor: '#e8a33d' }}>
            <strong>Traías un recorrido sin terminar</strong>
            <div className="datos">
              {sesionPrevia.equipo ? sesionPrevia.equipo + ' · ' : ''}
              {sesionPrevia.ruta.length} bardas
            </div>
            <p className="nota" style={{ marginTop: 6 }}>
              Se retoma con las mismas bardas y en el mismo orden que traías. Si
              empiezas uno nuevo, esas bardas se sueltan para que las tome otro equipo.
            </p>
            <div className="fila" style={{ marginTop: 8 }}>
              <button className="boton primario" onClick={retomarRecorrido}>
                ▶ Retomar recorrido
              </button>
              <button className="boton suave" onClick={descartarSesionPrevia}>
                Empezar uno nuevo
              </button>
            </div>
          </div>
        )}

        {!cargando && !sesionPrevia && fase === 'config' && (
          <>
            <label className="etiqueta">Tu equipo</label>
            <input
              type="text"
              autoComplete="off"
              value={equipo}
              onChange={(e) => setEquipo(e.target.value)}
            />

            <label className="etiqueta">Cantidad de bardas por hacer hoy</label>
            <input
              type="number"
              autoComplete="off"
              min="1"
              max={Math.max(1, pendientes.length)}
              value={cantidad}
              onChange={(e) => setCantidad(e.target.value)}
            />
            <p className="nota" style={{ marginTop: 0 }}>
              Se te arma la ruta con esas bardas, las más cercanas a donde estés.
            </p>

            <div className="fila" style={{ marginTop: 10 }}>
              <button
                className="boton primario"
                onClick={iniciarRecorrido}
                disabled={pendientes.length === 0}
              >
                🚀 Iniciar recorrido
              </button>
            </div>
            {pendientes.length === 0 && (
              <div className="aviso" style={{ background: '#f0f6ee', borderColor: '#cde3c8' }}>
                🎉 ¡Ya se preguntó en todas las bardas del listado!
              </div>
            )}
          </>
        )}

        {/* ---------- EN RECORRIDO ---------- */}
        {fase === 'recorrido' && (
          <>
            {calculando && (
              <div className="aviso">
                ⏳ {miPos ? 'Trazando la ruta por las calles…' : 'Buscando tu ubicación…'}
              </div>
            )}

            {ruta.length > 0 && (
              <>
                <h3>
                  Tu ruta de hoy ({ruta.length} bardas · {metrosBonito(largoDeRuta(ruta))})
                </h3>
                <p className="nota" style={{ marginTop: 0 }}>
                  {porCalles
                    ? 'Distancias y trazo por calles reales. Se eligió la zona con más bardas juntas cerca de ti.'
                    : 'No se pudieron bajar las calles (¿sin señal?): el orden y las distancias son en línea recta.'}
                </p>
                {/* Si no hay bardas cerca, el primer tramo es largo: mejor
                    decirlo de frente que dejar al equipo descubrirlo caminando. */}
                {ruta[0] && ruta[0].metrosDesdeAnterior > 1200 && (
                  <div className="aviso">
                    🚗 La barda más cercana está a{' '}
                    <strong>{metrosBonito(ruta[0].metrosDesdeAnterior)}</strong> de donde
                    estás: conviene trasladarse hasta allá. Ya en la zona, las demás
                    quedan a pocos metros entre sí.
                  </div>
                )}
                <ul className="lista-calles">
                  {ruta.map((b, i) => (
                    <li key={b.id} onClick={() => abrirRegistro(b)} style={{ cursor: 'pointer' }}>
                      <span>
                        <strong>{i + 1}.</strong> {b.direccion || 'Barda ' + b.id}
                        {b.foto ? ' 📷' : ''}
                        <br />
                        <span style={{ fontSize: '0.8rem', color: '#666' }}>
                          {b.colonia}
                          {b.metrosDesdeAnterior != null
                            ? ` · a ${metrosBonito(b.metrosDesdeAnterior)}`
                            : ''}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="fila" style={{ marginTop: 8 }}>
                  <button className="boton suave mini" onClick={recalcular} disabled={calculando}>
                    🔄 Recalcular desde donde estoy
                  </button>
                </div>
              </>
            )}

            {!calculando && ruta.length === 0 && miPos && (
              <div className="aviso" style={{ background: '#f0f6ee', borderColor: '#cde3c8' }}>
                ✅ Terminaste tu ruta.
                <div className="fila" style={{ marginTop: 8 }}>
                  <button className="boton primario mini" onClick={recalcular}>
                    Pedir otras {Math.max(1, parseInt(cantidad, 10) || CANTIDAD_SUGERIDA)} bardas
                  </button>
                </div>
              </div>
            )}

            <div className="fila" style={{ marginTop: 6 }}>
              <button className="boton suave mini" onClick={terminarRecorrido}>
                ⏹ Terminar recorrido
              </button>
            </div>
          </>
        )}

        {/* ---------- AGREGAR UNA BARDA QUE NO ESTÁ EN EL CATÁLOGO ---------- */}
        {!cargando && (
          <>
            <h3>¿Encontraste una barda que no está en la lista?</h3>
            {!agregando ? (
              <div className="fila" style={{ marginTop: 0 }}>
                <button className="boton suave mini" onClick={abrirAgregar}>
                  ➕ Agregar barda nueva
                </button>
              </div>
            ) : (
              <div className="tarjeta-equipo" style={{ borderLeftColor: '#1d6fd1' }}>
                <label className="etiqueta">Dirección (opcional)</label>
                <input
                  type="text"
                  autoComplete="off"
                  value={formNueva.direccion}
                  onChange={(e) => setFormNueva((f) => ({ ...f, direccion: e.target.value }))}
                />

                <label className="etiqueta">Colonia (opcional)</label>
                <input
                  type="text"
                  autoComplete="off"
                  value={formNueva.colonia}
                  onChange={(e) => setFormNueva((f) => ({ ...f, colonia: e.target.value }))}
                />

                <label className="etiqueta">Distrito (opcional)</label>
                <input
                  type="text"
                  autoComplete="off"
                  inputMode="numeric"
                  value={formNueva.distrito}
                  onChange={(e) => setFormNueva((f) => ({ ...f, distrito: e.target.value }))}
                />

                {(autollenando || comoSeDedujo) && (
                  <p className="nota" style={{ marginTop: 4 }}>
                    {autollenando
                      ? '🔎 Buscando la dirección de donde estás…'
                      : `✨ ${comoSeDedujo} Corrígelo si algo no cuadra; el número de la casa hay que escribirlo a mano.`}
                  </p>
                )}

                <label className="etiqueta">Foto (opcional)</label>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => {
                    const archivo = e.target.files?.[0] || null;
                    if (formNueva.previewUrl) URL.revokeObjectURL(formNueva.previewUrl);
                    setFormNueva((f) => ({
                      ...f,
                      archivo,
                      previewUrl: archivo ? URL.createObjectURL(archivo) : null
                    }));
                  }}
                />
                {formNueva.previewUrl && (
                  <img
                    src={formNueva.previewUrl}
                    alt=""
                    style={{
                      width: '100%',
                      maxHeight: 180,
                      objectFit: 'cover',
                      borderRadius: 8,
                      marginTop: 8
                    }}
                  />
                )}

                <label className="etiqueta">O pega el link de ubicación de Google Maps (opcional)</label>
                <div className="fila">
                  <input
                    type="text"
                    autoComplete="off"
                    placeholder="https://maps.app.goo.gl/..."
                    value={linkNueva}
                    onChange={(e) => setLinkNueva(e.target.value)}
                  />
                  <button
                    className="boton suave mini"
                    onClick={usarLink}
                    disabled={resolviendoLink || !linkNueva.trim()}
                  >
                    {resolviendoLink ? 'Leyendo…' : 'Usar este link'}
                  </button>
                </div>
                {linkNuevaError && (
                  <div className="aviso" style={{ background: '#fff0f0', borderColor: '#e3b3b3' }}>
                    ⚠ {linkNuevaError}
                  </div>
                )}

                <div className="aviso" style={{ marginTop: 8 }}>
                  {posNueva
                    ? `📍 Ubicación lista (${posNueva[0].toFixed(5)}, ${posNueva[1].toFixed(5)})`
                    : gpsNuevaError
                    ? `⚠ ${gpsNuevaError}`
                    : '📍 Obteniendo tu ubicación…'}
                  {gpsNuevaError && (
                    <div className="fila" style={{ marginTop: 6 }}>
                      <button className="boton suave mini" onClick={abrirAgregar}>
                        🔄 Reintentar
                      </button>
                    </div>
                  )}
                </div>

                <div className="fila" style={{ marginTop: 8 }}>
                  <button
                    className="boton primario mini"
                    onClick={guardarNueva}
                    disabled={guardandoNueva || !posNueva}
                  >
                    {guardandoNueva ? 'Guardando…' : '✅ Guardar barda'}
                  </button>
                  <button className="boton suave mini" onClick={cerrarAgregar}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ---------- MARCAR UNA BARDA HECHA SIN LA APP ---------- */}
        {!cargando && (
          <>
            <h3>¿Ya se hizo una barda sin la app?</h3>
            <p className="nota" style={{ marginTop: 0 }}>
              Búscala por dirección o colonia y márcala, aunque no esté en tu ruta.
            </p>
            <input
              type="text"
              autoComplete="off"
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
            />
            {resultados.map((b) => {
              const est = estadoDe(b);
              return (
                <div key={b.id} className="resultado" onClick={() => abrirRegistro(b)}>
                  <strong>{b.direccion || 'Barda ' + b.id}</strong>
                  {b.foto ? ' 📷' : ''}
                  <div style={{ fontSize: '0.8rem', color: '#666' }}>
                    {b.colonia}
                    {est ? ` · ${infoEstado(est)?.etiqueta || 'atendida'}` : ' · pendiente'}
                    {b.lat == null ? ' · sin ubicación' : ''}
                  </div>
                </div>
              );
            })}
            {busqueda.trim().length >= 2 && resultados.length === 0 && (
              <div className="aviso">No hay bardas que coincidan con «{busqueda}».</div>
            )}
          </>
        )}

        {/* ---------- CORTE PARA LA OFICINA ---------- */}
        {!cargando && (
          <>
            <h3>Corte</h3>
            <p className="nota" style={{ marginTop: 0 }}>
              Baja un Excel con en qué quedó cada barda y qué equipo la hizo.
            </p>
            <label className="etiqueta">¿Qué bardas incluir?</label>
            <div className="fila" style={{ flexWrap: 'wrap' }}>
              {FILTROS_CORTE.map((f) => (
                <button
                  key={f.id}
                  className={filtroCorte === f.id ? 'boton primario mini' : 'boton suave mini'}
                  onClick={() => setFiltroCorte(f.id)}
                >
                  {f.etiqueta}
                </button>
              ))}
            </div>
            <p className="nota" style={{ marginTop: 4 }}>
              {FILTROS_CORTE.find((f) => f.id === filtroCorte)?.descripcion}
            </p>
            <div className="fila">
              <button className="boton suave mini" onClick={exportarCorte} disabled={exportando}>
                {exportando ? 'Armando el Excel…' : '📄 Exportar corte a Excel'}
              </button>
            </div>
          </>
        )}

        {/* ---------- FORMULARIO ---------- */}
        {registrando && (
          <div className="tarjeta-equipo" style={{ borderLeftColor: '#1d6fd1', marginTop: 12 }}>
            <strong>{registrando.direccion || 'Barda ' + registrando.id}</strong>
            <div className="datos">{registrando.colonia}</div>

            {registrando.previo && (
              <div className="aviso" style={{ background: '#fff8e6', borderColor: '#f0d9a0' }}>
                Esta barda ya se registró como{' '}
                <strong>{infoEstado(registrando.previo)?.corto || 'atendida'}</strong>
                {registrando.previo.equipo ? ` (${registrando.previo.equipo})` : ''}. Puedes
                corregir los datos y volver a guardar, o quitar el registro si fue por error.
              </div>
            )}

            {registrando.foto && (
              <img
                src={urlFoto(registrando.foto)}
                alt="Foto de la barda"
                style={{
                  width: '100%',
                  maxHeight: 220,
                  objectFit: 'cover',
                  borderRadius: 8,
                  margin: '8px 0',
                  cursor: 'zoom-in'
                }}
                onClick={() => window.open(urlFoto(registrando.foto), '_blank')}
              />
            )}

            <div className="fila">
              <button className="boton suave mini" onClick={() => comoLlegar(registrando)}>
                🧭 Cómo llegar
              </button>
            </div>

            <h3>¿Cómo te fue en esta barda?</h3>
            <div className="fila" style={{ flexWrap: 'wrap' }}>
              {ESTADOS.map((e) => (
                <button
                  key={e.id}
                  className={form.estado === e.id ? 'boton ' + e.boton : 'boton suave'}
                  style={
                    form.estado === e.id && e.boton === 'suave'
                      ? { background: e.color, color: '#fff', borderColor: e.color }
                      : undefined
                  }
                  onClick={() => setForm((f) => ({ ...f, estado: e.id }))}
                >
                  {e.etiqueta}
                </button>
              ))}
            </div>
            {form.estado === 'visitado' && (
              <p className="nota" style={{ marginTop: 4 }}>
                Sale de la ruta de hoy, pero vuelve a la lista de pendientes mañana:
                a esta barda todavía no se le ha preguntado a nadie.
              </p>
            )}

            {/* Editable a propósito: sirve para capturar bardas que otro
                equipo hizo a mano (se les cerró la app, o la hicieron sin
                ella) sin quedar registradas a nombre de quien las teclea. */}
            <label className="etiqueta">Equipo que la hizo</label>
            <input
              type="text"
              autoComplete="off"
              placeholder="Nombre del equipo"
              value={form.equipo}
              onChange={(e) => setForm((f) => ({ ...f, equipo: e.target.value }))}
            />

            <label className="etiqueta">Nombre de quien atendió</label>
            <input
              type="text"
              autoComplete="off"
              value={form.nombre}
              onChange={(e) => setForm((f) => ({ ...f, nombre: e.target.value }))}
            />

            <label className="etiqueta">Teléfono</label>
            <input
              type="tel"
              autoComplete="off"
              value={form.telefono}
              onChange={(e) => setForm((f) => ({ ...f, telefono: e.target.value }))}
            />

            {form.estado === 'con_permiso' && (
              <>
                <label className="etiqueta">¿Qué se dará a cambio?</label>
                <input
                  type="text"
                  autoComplete="off"
                  value={form.aCambio}
                  onChange={(e) => setForm((f) => ({ ...f, aCambio: e.target.value }))}
                />
              </>
            )}

            <label className="etiqueta">Notas (opcional)</label>
            <textarea
              rows="2"
              value={form.notas}
              onChange={(e) => setForm((f) => ({ ...f, notas: e.target.value }))}
            />

            <div className="fila" style={{ marginTop: 10 }}>
              <button
                className="boton primario"
                onClick={guardar}
                disabled={!form.estado || guardando}
              >
                {guardando ? 'Guardando…' : 'Guardar'}
              </button>
              <button className="boton suave" onClick={() => setRegistrando(null)}>
                Cancelar
              </button>
            </div>
            {!form.estado && (
              <p className="nota" style={{ marginTop: 6 }}>
                Marca primero cómo te fue.
              </p>
            )}
            {registrando.previo && (
              <div className="fila" style={{ marginTop: 4 }}>
                <button
                  className="boton peligro mini"
                  onClick={() => deshacer(registrando.id)}
                  disabled={guardando}
                >
                  ↩ Quitar este registro (fue por error)
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

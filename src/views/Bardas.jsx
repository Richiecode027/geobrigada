import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { useMap } from '../components/useMap.js';
import AsaPanel from '../components/AsaPanel.jsx';
import { iniciarGPS, obtenerPosicionActual } from '../lib/gps.js';
import { registrarAtras } from '../lib/atras.js';
import { comprimirImagen } from '../lib/imagen.js';
import { coordsDeLinkMaps } from '../lib/mapsLink.js';
import { ubicacionAproximada } from '../lib/ubicacion.js';
import { seguirBrujula, pedirPermisoBrujula } from '../lib/brujula.js';
import { cargarDistritos, COLOR_DISTRITO } from '../lib/distritos.js';
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
  actualizarBardaNueva,
  borrarBardaNueva,
  subirFotoBardaNueva,
  cargarReservasBardas,
  apartarBarda,
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
    referencia: null,
    creado: n.creado,
    // Las del Excel no se pueden tocar desde el teléfono (viven en un archivo
    // del sitio); estas sí, porque están en la nube.
    agregadaEnApp: true
  };
}

const idNuevo = () =>
  'n-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));

// Los cuatro resultados posibles de una visita. El orden es el de los botones.
const ESTADOS = [
  { id: 'con_permiso', etiqueta: '✅ Sí dio permiso', corto: 'Con permiso', color: '#2a9d3a', pin: '✓', boton: 'exito' },
  { id: 'sin_permiso', etiqueta: '❌ No dio permiso', corto: 'Sin permiso', color: '#c1121f', pin: '✕', boton: 'peligro' },
  { id: 'visitado', etiqueta: '🚪 No había nadie', corto: 'Visitado', color: '#7b61c9', pin: '?', boton: 'suave' },
  // Amarillo, no gris: en gris se confundía con las que faltan por visitar,
  // que es justo lo contrario (a esta ya nadie tiene que volver).
  { id: 'no_habitado', etiqueta: '🏚 Casa sola / abandonada', corto: 'No habitado', color: '#ffd21e', colorTexto: '#4a3b00', pin: '—', boton: 'suave' }
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

function metrosBonito(m) {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

// Quita acentos y mayúsculas para buscar sin que estorben.
const normalizar = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Pin numerado: verde = con permiso, rojo = sin permiso, azul = en la ruta de
// hoy (con su número de orden), gris = pendiente pero fuera de la ruta.
function pinBarda(latlng, texto, color, colorTexto) {
  // Sobre fondos claros (el amarillo de "casa sola") el blanco de siempre no
  // se lee: por eso cada estado puede pedir su propio color de letra.
  const letra = colorTexto ? `;color:${colorTexto}` : '';
  return L.marker(latlng, {
    icon: L.divIcon({
      className: 'pin-barda',
      html: `<div style="background:${color}${letra}">${texto}</div>`,
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
  const capaDistritos = useRef(null);
  const capaLineaDirecta = useRef(null);
  const detenerGPS = useRef(null);
  const yaCalculada = useRef(false);

  const [todas, setTodas] = useState([]);
  const [permisos, setPermisos] = useState([]);
  const [reservas, setReservas] = useState([]);
  const [miPos, setMiPos] = useState(null);
  // Grados a los que mira el teléfono (null si no tiene brújula).
  const [rumbo, setRumbo] = useState(null);
  // Apagado por omisión: dibujar los 4 polígonos encima de ~250 pines se
  // siente pesado en el teléfono, y para caminar no hacen falta. Quien los
  // necesite los prende.
  const [verDistritos, setVerDistritos] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [gpsError, setGpsError] = useState('');

  // Lo que quedó guardado la última vez que se usó la app en este teléfono.
  const [sesionInicial] = useState(leerSesion);

  // 'config' = antes de empezar (equipo, cuántas bardas) · 'recorrido' = en camino
  const [fase, setFase] = useState('config');
  const [equipo, setEquipo] = useState(sesionInicial?.equipo || '');
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
  // null = se está dando de alta una barda nueva · id = se está corrigiendo esa
  const [editandoId, setEditandoId] = useState(null);

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

  // Antes esto se preguntaba cada 30 segundos, y era el 90% de todo lo que la
  // app le pedía a la nube en una jornada. Como apartar ahora es un acto
  // deliberado y no vence, basta con leerlo al abrir y volver a leerlo justo
  // antes de calcular la ruta (que es el único momento en que estorbaría
  // traer datos viejos).
  async function refrescarReservas() {
    if (!nubeConfigurada()) return [];
    try {
      const r = await cargarReservasBardas();
      setReservas(r);
      return r;
    } catch {
      return reservas;
    }
  }

  // Solo los registros vigentes (no anulados) cierran la barda.
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

  // Nombre legible para las bardas agregadas desde la app: nunca el id crudo
  // (un uuid no le dice nada a nadie). Si falta la dirección, se usa la
  // colonia; si dos bardas nuevas caen en la misma calle —muy común, OSM
  // repite el mismo nombre en tramos largos— se numeran para distinguirlas,
  // en el orden en que se capturaron.
  const nombresBardasNuevas = useMemo(() => {
    const nuevas = todas
      .filter((b) => b.agregadaEnApp)
      .slice()
      .sort((a, b) => String(a.creado || '').localeCompare(String(b.creado || '')));

    const base = new Map();
    for (const b of nuevas) {
      const nombre =
        (b.direccion && b.direccion.trim()) ||
        (b.colonia ? `Barda en ${b.colonia}` : 'Barda sin dirección');
      base.set(b.id, nombre);
    }
    const cuenta = new Map();
    for (const nombre of base.values()) cuenta.set(nombre, (cuenta.get(nombre) || 0) + 1);

    const contador = new Map();
    const resultado = new Map();
    for (const b of nuevas) {
      const nombre = base.get(b.id);
      if (cuenta.get(nombre) > 1) {
        const n = (contador.get(nombre) || 0) + 1;
        contador.set(nombre, n);
        resultado.set(b.id, `${nombre} ${n}`);
      } else {
        resultado.set(b.id, nombre);
      }
    }
    return resultado;
  }, [todas]);

  function nombreBarda(b) {
    if (b.agregadaEnApp) return nombresBardasNuevas.get(b.id) || 'Barda sin dirección';
    return b.direccion || 'Barda ' + b.id;
  }

  // Bardas apartadas por OTRO equipo (las propias van aparte, más abajo).
  const reservasAjenas = useMemo(() => {
    const miEquipo = equipo.trim();
    const m = new Map();
    for (const r of reservas) {
      if ((r.equipo || '') === miEquipo) continue;
      m.set(String(r.barda_id), r);
    }
    return m;
  }, [reservas, equipo]);

  // Las que MI equipo apartó y todavía no ha registrado: esas son las que la
  // app va a ordenar cuando pida la ruta.
  const misApartadas = useMemo(() => {
    const miEquipo = equipo.trim();
    if (!miEquipo) return [];
    const mias = new Set(
      reservas.filter((r) => (r.equipo || '') === miEquipo).map((r) => String(r.barda_id))
    );
    return pendientes.filter((b) => mias.has(String(b.id)));
  }, [reservas, equipo, pendientes]);

  const apartadaPor = (bardaId) =>
    reservas.find((r) => String(r.barda_id) === String(bardaId))?.equipo || null;

  // Guarda la jornada en el teléfono a cada cambio, para poder retomarla si la
  // app se cierra. Mientras haya una sesión previa esperando respuesta no se
  // toca nada: si no, el arranque en fase 'config' la borraría.
  useEffect(() => {
    if (sesionPrevia) return;
    if (fase === 'recorrido' && ruta.length > 0) {
      guardarSesion({ equipo, fase, ruta, porCalles });
    } else if (equipo.trim()) {
      // Aunque no traiga ruta, se recuerda QUIÉN es: de ahí depende que la app
      // reconozca cuáles bardas apartó él y cuáles son de otro equipo.
      guardarSesion({ equipo, fase: 'config', ruta: [] });
    }
  }, [equipo, fase, ruta, porCalles, sesionPrevia]);

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

  // Retoma el recorrido tal cual iba: MISMO orden, sin recalcular (recalcular
  // le cambiaría el camino a media jornada). Solo se quitan las bardas que
  // alguien haya registrado mientras la app estuvo cerrada. Ya no hay que
  // volver a apartarlas: siguen apartadas en la nube, que es justo el punto.
  function retomarRecorrido() {
    const guardada = sesionPrevia;
    setSesionPrevia(null);
    const vivas = new Set(pendientes.map((b) => String(b.id)));
    setRuta(guardada.ruta.filter((b) => vivas.has(String(b.id))));
    setPorCalles(Boolean(guardada.porCalles));
    yaCalculada.current = true;
    setFase('recorrido'); // el efecto del GPS lo pasa solo a modo completo
    setError('');
    setGpsError('');
  }

  // Solo olvida el orden guardado. Las bardas SIGUEN apartadas: el equipo las
  // eligió a propósito y soltarlas es otra decisión, con su propio botón.
  function descartarSesionPrevia() {
    borrarSesion();
    setSesionPrevia(null);
  }

  function terminarRecorrido() {
    borrarSesion();
    setFase('config'); // el efecto del GPS regresa solo a modo ligero
    setRuta([]);
  }

  // Soltar la barda que se está viendo, de un toque. Se puede hacer también
  // borrando el nombre del equipo y guardando, pero eso obliga a pelearse con
  // el teclado en plena calle.
  // Apartar / quitar apartado: acción de un toque junto a "Cómo llegar", sin
  // pasar por el formulario de abajo (que ya solo registra el resultado de
  // la visita). Deshabilitado si no hay equipo escrito: no hay a nombre de
  // quién apartarla.
  async function alternarApartado() {
    if (!registrando) return;
    const miEquipo = equipo.trim();
    if (!miEquipo) return;
    const id = String(registrando.id);
    const esMia = registrando.apartadaPor === miEquipo;
    setGuardando(true);
    const ok = esMia ? ((await liberarReservasBardas([id])), true) : await apartarBarda(id, miEquipo);
    await refrescarReservas();
    setGuardando(false);
    if (!ok) {
      setError('No se pudo guardar el apartado (¿sin señal?). Intenta de nuevo.');
      return;
    }
    const nuevoApartador = esMia ? null : miEquipo;
    setRegistrando((r) => (r ? { ...r, apartadaPor: nuevoApartador } : r));
    setForm((f) => ({ ...f, equipo: nuevoApartador || '' }));
    if (esMia) setRuta((r) => r.filter((b) => String(b.id) !== id));
    setError('');
  }

  // Suelta de golpe todo lo que trae apartado este equipo.
  async function soltarTodas() {
    const ids = misApartadas.map((b) => b.id);
    if (ids.length === 0) return;
    if (!window.confirm(`¿Soltar las ${ids.length} bardas que traes apartadas? Quedarán libres para cualquier equipo.`)) return;
    await liberarReservasBardas(ids);
    await refrescarReservas();
    setRuta([]);
    borrarSesion();
    setFase('config');
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
    setEditandoId(null);
  }

  // Corregir una barda que ya se había agregado desde la app: se abre el mismo
  // formulario, pero con sus datos puestos y sin volver a preguntar la
  // ubicación (la que trae es la buena, salvo que la cambien a propósito).
  function abrirEditar(b) {
    setError('');
    setRegistrando(null);
    setEditandoId(b.id);
    setAgregando(true);
    setFormNueva({
      direccion: b.direccion || '',
      colonia: b.colonia || '',
      distrito: b.distrito || '',
      archivo: null,
      previewUrl: null
    });
    setPosNueva(b.lat != null ? [b.lat, b.lng] : null);
    setGpsNuevaError('');
    setLinkNueva('');
    setLinkNuevaError('');
    setComoSeDedujo('');
    posDeLinkRef.current = true; // que el GPS no le gane a la ubicación guardada
    ubicacionResuelta.current = b.lat != null ? [b.lat, b.lng].join(',') : null;
  }

  async function borrarBarda(b) {
    if (!window.confirm(`¿Seguro que quieres eliminar la barda "${nombreBarda(b)}"?`)) return;
    if (!window.confirm('¿De verdad seguro? Va a desaparecer de la lista de todos los equipos.')) return;
    setGuardando(true);
    const ok = await borrarBardaNueva(b.id);
    setGuardando(false);
    if (!ok) {
      setError('No se pudo eliminar (¿sin señal?). Intenta de nuevo.');
      return;
    }
    setTodas((t) => t.filter((x) => String(x.id) !== String(b.id)));
    setRuta((r) => r.filter((x) => String(x.id) !== String(b.id)));
    await liberarReservasBardas([String(b.id)]);
    await refrescarReservas();
    setRegistrando(null);
    setError('');
  }

  // Con la ubicación ya se puede saber casi todo: la colonia sale del catálogo
  // del INEGI que trae la app, el distrito se deduce de las bardas ya
  // capturadas y la calle la da OpenStreetMap. Solo se rellena lo que esté
  // vacío: si el equipo ya escribió algo, manda lo que escribió.
  const ubicacionResuelta = useRef(null);
  useEffect(() => {
    // Al corregir una barda no se autollena: sus datos ya están y sería
    // pisarlos con una suposición.
    if (!agregando || !posNueva || editandoId) return;
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
  }, [agregando, posNueva, todas, editandoId]);

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
    const id = editandoId || idNuevo();

    // La foto solo se toca si eligieron una nueva: al corregir la dirección
    // no hay por qué volver a subir la que ya estaba.
    let foto;
    if (formNueva.archivo) {
      try {
        const comprimida = await comprimirImagen(formNueva.archivo);
        foto = await subirFotoBardaNueva(id, comprimida);
      } catch {
        /* si falla la foto, se guarda igual (la ubicación es lo importante) */
      }
    }

    const datos = {
      direccion: formNueva.direccion.trim() || null,
      colonia: formNueva.colonia.trim() || null,
      distrito: formNueva.distrito.trim() || null,
      lat: posNueva[0],
      lng: posNueva[1]
    };
    if (foto !== undefined) datos.foto = foto;

    const ok = editandoId
      ? await actualizarBardaNueva(id, datos)
      : await guardarBardaNueva({ ...datos, id, foto: foto ?? null, equipo: equipo.trim() || null });
    setGuardandoNueva(false);
    if (!ok) {
      setError(
        editandoId
          ? 'No se pudo guardar la corrección (¿sin señal?). Intenta de nuevo.'
          : 'No se pudo guardar la barda nueva (¿sin señal?). Intenta de nuevo.'
      );
      return;
    }

    setTodas((t) =>
      editandoId
        ? t.map((b) => (String(b.id) === String(id) ? { ...b, ...datos } : b))
        : [...t, aBardaCatalogo({ ...datos, id, foto: foto ?? null })]
    );
    if (formNueva.previewUrl) URL.revokeObjectURL(formNueva.previewUrl);
    setAgregando(false);
    setEditandoId(null);
    // Si el intento anterior había fallado, el aviso viejo tiene que irse:
    // si no, queda diciendo "no se pudo guardar" sobre una barda ya guardada.
    setError('');
  }

  // --- armar la ruta con lo que el equipo ya apartó -------------------------
  async function iniciarRecorrido() {
    setError('');
    setGpsError('');
    // Se relee por si alguien soltó o tomó algo desde otro teléfono.
    await refrescarReservas();
    yaCalculada.current = false;
    setCalculando(true);
    setFase('recorrido'); // el efecto del GPS lo pasa solo a modo completo
  }

  // Ordena las bardas que el equipo YA apartó. No elige ni descarta ninguna:
  // eso lo decidió el equipo al apartarlas.
  async function calcularRuta(desde, seleccionadas) {
    setCalculando(true);
    const r = await rutaDeBardasPorCalles(desde, seleccionadas);
    setRuta(r.ruta);
    setPorCalles(r.porCalles);
    setCalculando(false);
  }

  // Con la primera ubicación se arma la ruta (una sola vez: si se recalculara
  // a cada paso del GPS, el orden cambiaría mientras el equipo camina).
  useEffect(() => {
    if (fase !== 'recorrido' || !miPos || yaCalculada.current || misApartadas.length === 0) return;
    yaCalculada.current = true;
    calcularRuta(miPos, misApartadas);
  }, [fase, miPos, misApartadas]);

  // Rehace el orden desde donde está parado ahora, con lo que le quede.
  async function recalcular() {
    if (!miPos) return;
    await refrescarReservas();
    await calcularRuta(miPos, misApartadas);
  }

  // --- mapa ----------------------------------------------------------------
  // OJO con la lista de dependencias de aquí abajo: este efecto tira y vuelve
  // a crear los ~350 pines, que son la mayor parte de los elementos de la
  // pantalla. Tenía `miPos` entre sus dependencias, así que se rehacía con
  // CADA lectura del GPS — o sea, cada pocos segundos mientras el brigadista
  // camina, que es justo cuando necesita mover el mapa. De ahí que se sintiera
  // trabado en el teléfono. Solo debe rehacerse cuando cambian los DATOS.
  useEffect(() => {
    if (!map) return;
    if (capaBardas.current) capaBardas.current.remove();
    const g = L.layerGroup().addTo(map);
    const porId = new Map(permisosVigentes.map((p) => [String(p.barda_id), p]));
    const enRuta = new Map(ruta.map((b, i) => [String(b.id), i + 1]));
    const esMia = new Set(misApartadas.map((b) => String(b.id)));

    for (const b of todas) {
      if (b.lat == null) continue;
      const visita = porId.get(String(b.id));
      const orden = enRuta.get(String(b.id));
      const apartada = reservasAjenas.get(String(b.id));
      const info = visita ? infoEstado(visita) : null;
      const miaApartada = !visita && !orden && esMia.has(String(b.id));
      let color = '#9aa5b1';
      let texto = '';
      let colorTexto = null;
      if (info) {
        color = info.color;
        texto = info.pin;
        colorTexto = info.colorTexto || null;
      } else if (orden) {
        color = '#1d6fd1';
        texto = String(orden);
      } else if (miaApartada) {
        // Apartada por mí pero todavía sin orden de ruta.
        color = '#1d6fd1';
        texto = '📌';
      } else if (apartada) {
        color = '#e8a33d';
        texto = '🔒';
      }
      pinBarda([b.lat, b.lng], texto, color, colorTexto)
        .bindTooltip(
          `<strong>${nombreBarda(b)}</strong><br>${b.colonia || ''}` +
            (info
              ? `<br>${info.etiqueta}${visita.equipo ? ` · ${visita.equipo}` : ''}`
              : miaApartada
              ? '<br>📌 La tienes apartada'
              : apartada
              ? `<br>🔒 Apartada por ${apartada.equipo || 'otro equipo'}`
              : '')
        )
        .on('click', () => abrirRegistro(b))
        .addTo(g);
    }

    // Trazo del recorrido por calles reales. (La línea punteada de respaldo va
    // en su propia capa, más abajo: esa sí depende de dónde estás parado y no
    // puede arrastrar a los pines a redibujarse con ella.)
    for (const b of ruta) {
      if (b.trazo && b.trazo.length > 1) {
        L.polyline(b.trazo, { color: '#1d6fd1', weight: 4, opacity: 0.75 }).addTo(g);
      }
    }
    capaBardas.current = g;
  }, [map, todas, permisosVigentes, reservasAjenas, misApartadas, ruta, porCalles]);

  // Línea punteada de tu posición a las bardas, solo cuando no se pudieron
  // bajar las calles. Capa aparte y ligera (una polilínea), para que seguir el
  // GPS no cueste rehacer los cientos de pines de arriba.
  useEffect(() => {
    if (!map) return;
    if (capaLineaDirecta.current) {
      capaLineaDirecta.current.remove();
      capaLineaDirecta.current = null;
    }
    if (porCalles || !miPos || ruta.length === 0) return;
    capaLineaDirecta.current = L.polyline([miPos, ...ruta.map((b) => [b.lat, b.lng])], {
      color: '#1d6fd1', weight: 3, opacity: 0.5, dashArray: '6 6', interactive: false
    }).addTo(map);
  }, [map, miPos, ruta, porCalles]);

  // Al plegar o desplegar el panel, el mapa cambia de tamaño: hay que avisarle
  // a Leaflet o se queda con el tamaño viejo y los pines salen corridos.
  useEffect(() => {
    if (!map) return;
    const tid = setTimeout(() => map.invalidateSize({ animate: false }), 80);
    return () => clearTimeout(tid);
  }, [map, panelPlegado]);

  // Límites de los distritos locales (trazo oficial del INE). Va por debajo de
  // los pines y sin relleno fuerte: es referencia, no el asunto principal.
  useEffect(() => {
    if (!map) return;
    if (capaDistritos.current) {
      capaDistritos.current.remove();
      capaDistritos.current = null;
    }
    if (!verDistritos) return;

    let vivo = true;
    cargarDistritos()
      .then(({ distritos }) => {
        if (!vivo || !map) return;
        const g = L.layerGroup().addTo(map);
        for (const z of distritos) {
          const color = COLOR_DISTRITO[z.d] || '#888';
          L.polygon(z.rings, {
            color,
            weight: 2,
            opacity: 0.85,
            fillColor: color,
            fillOpacity: 0.06,
            dashArray: '5 4',
            interactive: false
          })
            .addTo(g);
          // El número, en el punto más ancho de la parte más grande.
          const mayor = z.rings.reduce((a, b) => (b.length > a.length ? b : a), z.rings[0]);
          const centro = L.polygon(mayor).getBounds().getCenter();
          L.marker(centro, {
            interactive: false,
            icon: L.divIcon({
              className: 'etiqueta-distrito',
              html: `<div style="border-color:${color};color:${color}">D${z.d}</div>`,
              iconSize: [40, 20],
              iconAnchor: [20, 10]
            })
          }).addTo(g);
        }
        g.eachLayer((c) => c.bringToBack?.());
        capaDistritos.current = g;
      })
      .catch(() => {
        /* sin catálogo de distritos el mapa funciona igual */
      });

    return () => {
      vivo = false;
    };
  }, [map, verDistritos]);

  // Dónde estás y hacia dónde ves. Con brújula sale una flecha que gira con el
  // teléfono (caminando en una colonia desconocida, "hacia dónde voy" importa
  // más que "dónde estoy"); sin brújula, el punto de siempre.
  //
  // Va con interactive:false a propósito: si no, al estar parado JUNTO a una
  // barda —que es lo normal al acabar de registrarla— la flecha tapaba el pin
  // y los toques se los quedaba ella. Así los dedos pasan de largo hasta la
  // barda de abajo. Se pierde el globito de "aquí estás tú", que igual no
  // hacía falta explicar.
  useEffect(() => {
    if (!map || !miPos) return;
    if (capaYo.current) capaYo.current.remove();
    const g = L.layerGroup().addTo(map);
    if (rumbo == null) {
      L.circleMarker(miPos, {
        radius: 8, color: '#fff', weight: 2, fillColor: '#1d6fd1', fillOpacity: 1,
        interactive: false
      }).addTo(g);
    } else {
      L.marker(miPos, {
        zIndexOffset: 1000,
        interactive: false,
        keyboard: false,
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
      }).addTo(g);
    }
    capaYo.current = g;
  }, [map, miPos, rumbo]);

  // Al abrir, en cuanto llega la primera ubicación el mapa se va ahí. Antes
  // arrancaba mostrando todo Morelia y había que buscarse a uno mismo entre
  // cientos de pines. Solo la primera vez: después el brigadista manda, que
  // para eso mueve el mapa.
  const yaCentrado = useRef(false);
  useEffect(() => {
    if (!map || !miPos || yaCentrado.current) return;
    yaCentrado.current = true;
    // Si ya hay ruta, el encuadre de abajo sabe más (mete todas las bardas).
    if (ruta.length > 0) return;
    map.invalidateSize({ animate: false });
    map.setView(miPos, 16, { animate: false });
  }, [map, miPos, ruta.length]);

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

  // Al tocar una barda (en el mapa o en la lista) la ficha queda a la vista
  // sola: se despliega el panel si estaba plegado y se baja hasta ella. Antes
  // había que abrir el panel y buscarla a mano cada vez.
  const fichaRef = useRef(null);
  useEffect(() => {
    if (!registrando) return;
    setPanelPlegado(false);
    // Un respiro para que el panel termine de desplegarse antes de medir
    // dónde quedó la ficha.
    const tid = setTimeout(() => {
      fichaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
    return () => clearTimeout(tid);
  }, [registrando]);

  // Mismo truco para el formulario de agregar/corregir barda: el botón que lo
  // abre ahora vive arriba, lejos de donde aparece el formulario.
  const formNuevaRef = useRef(null);
  useEffect(() => {
    if (!agregando) return;
    setPanelPlegado(false);
    const tid = setTimeout(() => {
      formNuevaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 120);
    return () => clearTimeout(tid);
  }, [agregando]);

  // --- registrar el resultado de la visita ----------------------------------
  function abrirRegistro(b) {
    const previo = permisosVigentes.find((p) => String(p.barda_id) === String(b.id));
    const apartador = apartadaPor(b.id);
    setRegistrando({ ...b, previo: previo || null, apartadaPor: apartador });
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
        : {
            estado: null, nombre: '', telefono: '', aCambio: '', notas: '',
            // Si ya la apartó alguien se muestra ese nombre (borrarlo la
            // suelta); si está libre, se propone el equipo de quien la abre,
            // para que apartarla sea un solo toque.
            equipo: apartador || equipo
          }
    );
  }

  // Un solo botón para las dos cosas que se pueden hacer con una barda, según
  // lo que traiga lleno el formulario:
  //   · con un resultado marcado -> se registra la visita (y se suelta, porque
  //     ya se atendió: nadie más tiene por qué esperarla).
  //   · sin resultado pero con nombre de equipo -> queda APARTADA para ese
  //     equipo, sin vencimiento.
  //   · sin resultado y sin nombre -> se suelta y vuelve a estar libre.
  async function guardar() {
    if (!registrando || !form.estado) return;
    const id = String(registrando.id);
    const nombreEquipo = form.equipo.trim();
    setGuardando(true);

    const fila = {
      barda_id: id,
      estado: form.estado,
      nombre: form.nombre.trim() || null,
      telefono: form.telefono.trim() || null,
      a_cambio: form.aCambio.trim() || null,
      notas: form.notas.trim() || null,
      equipo: nombreEquipo || null,
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
    setPermisos((p) => [...p.filter((x) => String(x.barda_id) !== id), guardada]);
    // Sale de la ruta de hoy; el resto conserva su orden (no se recalcula sola
    // para no cambiarle el camino al equipo a media jornada).
    setRuta((r) => r.filter((b) => String(b.id) !== id));
    await liberarReservasBardas([id]);
    await refrescarReservas();
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
        <AsaPanel plegado={panelPlegado} onCambiar={setPanelPlegado} />
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

        {!cargando && (
          <div className="fila">
            <button
              className={verDistritos ? 'boton primario mini' : 'boton suave mini'}
              onClick={() => setVerDistritos((v) => !v)}
            >
              {verDistritos ? '🗺️ Ocultar distritos' : '🗺️ Ver distritos'}
            </button>
            {!agregando && (
              <button className="boton suave mini" onClick={abrirAgregar}>
                ➕ Agregar barda
              </button>
            )}
          </div>
        )}

        {/* ---------- RETOMAR UN RECORRIDO QUE SE QUEDÓ A MEDIAS ---------- */}
        {!cargando && sesionPrevia && (
          <div className="tarjeta-equipo" style={{ borderLeftColor: '#e8a33d' }}>
            <strong>Traías un recorrido sin terminar</strong>
            <div className="datos">
              {sesionPrevia.equipo ? sesionPrevia.equipo + ' · ' : ''}
              {sesionPrevia.ruta.length} bardas
            </div>
            <div className="fila" style={{ marginTop: 8 }}>
              <button className="boton primario" onClick={retomarRecorrido}>
                ▶ Retomar recorrido
              </button>
              <button className="boton suave" onClick={descartarSesionPrevia}>
                Armar el orden de nuevo
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

            {!equipo.trim() ? null : misApartadas.length === 0 ? (
              <div className="aviso">Aún no traes bardas apartadas.</div>
            ) : (
              <>
                <div className="aviso" style={{ background: '#eef4fc', borderColor: '#c3d8f0' }}>
                  📌 Traes <strong>{misApartadas.length}</strong>{' '}
                  {misApartadas.length === 1 ? 'barda apartada' : 'bardas apartadas'}.
                </div>
                <ul className="lista-calles">
                  {misApartadas.map((b) => (
                    <li key={b.id} onClick={() => abrirRegistro(b)} style={{ cursor: 'pointer' }}>
                      <span>
                        {nombreBarda(b)}
                        {b.foto ? ' 📷' : ''}
                        <br />
                        <span style={{ fontSize: '0.8rem', color: '#666' }}>{b.colonia}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="fila" style={{ marginTop: 10 }}>
                  <button className="boton primario" onClick={iniciarRecorrido}>
                    🧭 Calcular mi ruta
                  </button>
                  <button className="boton suave mini" onClick={soltarTodas}>
                    Soltar todas
                  </button>
                </div>
              </>
            )}

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
                {!porCalles && (
                  <p className="nota" style={{ marginTop: 0 }}>
                    Sin señal para bajar las calles: el orden y las distancias son en línea recta.
                  </p>
                )}
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
                        <strong>{i + 1}.</strong> {nombreBarda(b)}
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
                ✅ Terminaste todas las que traías apartadas. Vuelve al inicio y
                aparta otras para seguir.
                <div className="fila" style={{ marginTop: 8 }}>
                  <button className="boton primario mini" onClick={terminarRecorrido}>
                    Apartar más bardas
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

        {/* ---------- AGREGAR / CORREGIR UNA BARDA ---------- */}
        {!cargando && agregando && (
          <>
            <h3>{editandoId ? 'Corregir la barda' : 'Barda nueva'}</h3>
            <div ref={formNuevaRef} className="tarjeta-equipo" style={{ borderLeftColor: '#1d6fd1' }}>
                {editandoId && (
                  <p className="nota" style={{ marginTop: 0 }}>
                    Si no eliges foto nueva, se queda la que ya tenía.
                  </p>
                )}
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

                {/* El distrito NO se pregunta: se deduce de la ubicación y se
                    guarda solo, porque el corte de la oficina lo lleva como
                    columna. Con la ubicación, la calle y la colonia ya está
                    identificada la barda; un campo más solo estorba en la calle. */}
                {(autollenando || comoSeDedujo) && (
                  <p className="nota" style={{ marginTop: 4 }}>
                    {autollenando
                      ? '🔎 Buscando la dirección de donde estás…'
                      : `✨ ${comoSeDedujo} Corrígelo si algo no cuadra.`}
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
                    {guardandoNueva
                      ? 'Guardando…'
                      : editandoId
                      ? '✅ Guardar cambios'
                      : '✅ Guardar barda'}
                  </button>
                  <button className="boton suave mini" onClick={cerrarAgregar}>
                    Cancelar
                  </button>
                </div>
            </div>
          </>
        )}

        {/* ---------- MARCAR UNA BARDA HECHA SIN LA APP ---------- */}
        {!cargando && (
          <>
            <h3>Buscar una barda</h3>
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
                  <strong>{nombreBarda(b)}</strong>
                  {b.foto ? ' 📷' : ''}
                  <div style={{ fontSize: '0.8rem', color: '#666' }}>
                    {b.colonia}
                    {est
                      ? ` · ${infoEstado(est)?.etiqueta || 'atendida'}`
                      : apartadaPor(b.id)
                      ? ` · 📌 apartada por ${apartadaPor(b.id)}`
                      : ' · libre'}
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
            <div className="fila">
              <button className="boton suave mini" onClick={exportarCorte} disabled={exportando}>
                {exportando ? 'Armando el Excel…' : '📄 Exportar corte a Excel'}
              </button>
            </div>
          </>
        )}

        {/* ---------- FORMULARIO ---------- */}
        {registrando && (
          <div
            ref={fichaRef}
            className="tarjeta-equipo"
            style={{ borderLeftColor: '#1d6fd1', marginTop: 12 }}
          >
            <strong>{nombreBarda(registrando)}</strong>
            <div className="datos">{registrando.colonia}</div>

            {registrando.previo && (
              <div className="aviso" style={{ background: '#fff8e6', borderColor: '#f0d9a0' }}>
                Esta barda ya se registró como{' '}
                <strong>{infoEstado(registrando.previo)?.corto || 'atendida'}</strong>
                {registrando.previo.equipo ? ` (${registrando.previo.equipo})` : ''}. Puedes
                corregir los datos y volver a guardar, o quitar el registro si fue por error.
              </div>
            )}

            {!registrando.previo && registrando.apartadaPor && (
              <div
                className="aviso"
                style={
                  registrando.apartadaPor === equipo.trim()
                    ? { background: '#eef4fc', borderColor: '#c3d8f0' }
                    : { background: '#fff3e0', borderColor: '#f0cf9a' }
                }
              >
                📌 Apartada por <strong>{registrando.apartadaPor}</strong>
                {registrando.apartadaPor === equipo.trim() ? ' (tu equipo).' : '.'}
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
              {!registrando.previo && (
                <button
                  className="boton suave mini"
                  onClick={alternarApartado}
                  disabled={guardando || !equipo.trim()}
                >
                  {!equipo.trim()
                    ? 'Escribe tu equipo arriba para apartar'
                    : registrando.apartadaPor === equipo.trim()
                    ? '🔓 Quitar apartado'
                    : '📌 Apartar para ' + equipo.trim()}
                </button>
              )}
              {/* Solo las que se capturaron desde la app se pueden corregir o
                  quitar: las del Excel viven en un archivo del sitio, no en la
                  nube, y desde el teléfono no hay forma de tocarlas. */}
              {registrando.agregadaEnApp && (
                <>
                  <button className="boton suave mini" onClick={() => abrirEditar(registrando)}>
                    ✏️ Editar
                  </button>
                  <button
                    className="boton peligro mini"
                    onClick={() => borrarBarda(registrando)}
                    disabled={guardando}
                  >
                    🗑 Eliminar
                  </button>
                </>
              )}
            </div>

            <label className="etiqueta">Equipo</label>
            <input
              type="text"
              autoComplete="off"
              value={form.equipo}
              onChange={(e) => setForm((f) => ({ ...f, equipo: e.target.value }))}
            />

            <h3>¿Ya la hiciste?</h3>
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
              <button className="boton primario" onClick={guardar} disabled={guardando || !form.estado}>
                {guardando ? 'Guardando…' : 'Guardar el resultado'}
              </button>
              <button className="boton suave" onClick={() => setRegistrando(null)}>
                Cancelar
              </button>
            </div>
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

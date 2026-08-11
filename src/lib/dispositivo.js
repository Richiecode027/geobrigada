// Identifica qué TELÉFONO hizo cada cambio — no el hardware (eso ningún
// navegador lo deja leer, por privacidad): un código al azar que se guarda
// una sola vez en este aparato y viaja con cada registro que sube. Sirve
// para saber, más adelante, qué teléfono hizo un grupo de cambios aunque no
// haya escrito su nombre de equipo esa vez.
//
// OJO: no es un identificador de hardware. Es "esta instalación de la app
// en este navegador" — se pierde si borran datos del navegador, reinstalan
// la app o la abren desde otro navegador en el mismo teléfono.
const CLAVE = 'geobrigada_dispositivo';

export function idDispositivo() {
  try {
    let id = localStorage.getItem(CLAVE);
    if (!id) {
      id = crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now() + '-' + Math.random().toString(36).slice(2);
      localStorage.setItem(CLAVE, id);
    }
    return id;
  } catch {
    return null; // navegación privada o localStorage bloqueado: no se puede identificar
  }
}

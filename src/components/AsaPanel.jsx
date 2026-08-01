import { useRef, useEffect } from 'react';

const ALTURA_COLAPSADA = 44; // debe coincidir con .panel.plegado en styles.css
const DURACION_MS = 220; // debe coincidir con la transición de .panel en styles.css

// Asa para plegar/desplegar el panel en el teléfono: solo la barrita, sin
// texto. Se puede tocar (alterna) o arrastrar — hacia abajo pliega, hacia
// arriba despliega — viéndose mover en tiempo real, como el tirador de una
// hoja a media pantalla en cualquier app nativa.
//
// `panelRef` apunta al contenedor .panel: mientras se arrastra, esta función
// le pone la altura en línea directamente (sin pasar por React) para que
// siga al dedo sin retraso; al soltar, decide si quedó más cerca de abierto
// o cerrado y termina la animación con la transición de CSS.
//
// Los eventos táctiles se enganchan "a mano" (addEventListener) y no como
// props de React: React los registra pasivos por default, y un listener
// pasivo NO PUEDE frenar el scroll con preventDefault() — sin esto, el
// primer intento se lo comía el gesto de desplazar la página en vez de
// llegarle a este código.
export default function AsaPanel({ plegado, onCambiar, panelRef }) {
  const botonRef = useRef(null);
  const estado = useRef(null);

  useEffect(() => {
    const boton = botonRef.current;
    const panel = panelRef.current;
    if (!boton || !panel) return;

    function empezar(y) {
      estado.current = {
        inicioY: y,
        alturaInicial: panel.getBoundingClientRect().height,
        alturaMaxima: Math.min(panel.scrollHeight, window.innerHeight * 0.5),
        arrastrando: false
      };
      panel.style.transition = 'none';
    }

    function mover(y, evento) {
      const e = estado.current;
      if (!e) return;
      const delta = y - e.inicioY;
      if (!e.arrastrando && Math.abs(delta) > 8) e.arrastrando = true;
      if (!e.arrastrando) return;
      // Ya es un arrastre de verdad: se le quita el gesto al scroll de la
      // página para que no se peleen por el mismo movimiento del dedo.
      evento?.preventDefault?.();
      const nueva = Math.min(e.alturaMaxima, Math.max(ALTURA_COLAPSADA, e.alturaInicial - delta));
      panel.style.maxHeight = nueva + 'px';
    }

    function terminar(y) {
      const e = estado.current;
      estado.current = null;
      if (!e) return;
      if (!e.arrastrando) {
        // Fue un toque, no un arrastre: alterna.
        panel.style.transition = '';
        panel.style.maxHeight = '';
        onCambiar(!plegado);
        return;
      }
      const delta = y - e.inicioY;
      const alturaFinal = Math.min(e.alturaMaxima, Math.max(ALTURA_COLAPSADA, e.alturaInicial - delta));
      const mitad = (ALTURA_COLAPSADA + e.alturaMaxima) / 2;
      const nuevoPlegado = alturaFinal < mitad;
      // Termina el recorrido desde donde iba el dedo hasta el destino final,
      // ahora sí con la transición prendida — así la última parte se ve
      // animada en vez de saltar de golpe.
      panel.style.transition = '';
      requestAnimationFrame(() => {
        panel.style.maxHeight = (nuevoPlegado ? ALTURA_COLAPSADA : e.alturaMaxima) + 'px';
      });
      setTimeout(() => {
        panel.style.maxHeight = '';
      }, DURACION_MS + 30);
      onCambiar(nuevoPlegado);
    }

    const alTouchStart = (ev) => empezar(ev.touches[0].clientY);
    const alTouchMove = (ev) => mover(ev.touches[0].clientY, ev);
    const alTouchEnd = (ev) => terminar(ev.changedTouches[0].clientY);
    boton.addEventListener('touchstart', alTouchStart, { passive: true });
    boton.addEventListener('touchmove', alTouchMove, { passive: false });
    boton.addEventListener('touchend', alTouchEnd);

    const alMouseDown = (ev) => {
      empezar(ev.clientY);
      const alMouseMove = (e2) => mover(e2.clientY);
      const alMouseUp = (e2) => {
        terminar(e2.clientY);
        window.removeEventListener('mousemove', alMouseMove);
        window.removeEventListener('mouseup', alMouseUp);
      };
      window.addEventListener('mousemove', alMouseMove);
      window.addEventListener('mouseup', alMouseUp);
    };
    boton.addEventListener('mousedown', alMouseDown);

    return () => {
      boton.removeEventListener('touchstart', alTouchStart);
      boton.removeEventListener('touchmove', alTouchMove);
      boton.removeEventListener('touchend', alTouchEnd);
      boton.removeEventListener('mousedown', alMouseDown);
    };
  }, [plegado, onCambiar, panelRef]);

  return (
    <button
      type="button"
      ref={botonRef}
      className="asa-panel"
      aria-label={plegado ? 'Mostrar panel' : 'Ocultar panel'}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          onCambiar(!plegado);
        }
      }}
    >
      <span className="asa-barrita" />
    </button>
  );
}

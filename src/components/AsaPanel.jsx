import { useRef } from 'react';

// Asa para plegar/desplegar el panel en el teléfono: solo la barrita, sin
// texto. Se puede tocar (alterna) o arrastrar — hacia abajo pliega, hacia
// arriba despliega — como el tirador de una hoja a media pantalla en
// cualquier app nativa.
export default function AsaPanel({ plegado, onCambiar }) {
  const inicioY = useRef(null);
  const arrastrando = useRef(false);

  function empezar(y) {
    inicioY.current = y;
    arrastrando.current = false;
  }
  function mover(y) {
    if (inicioY.current == null) return;
    if (Math.abs(y - inicioY.current) > 10) arrastrando.current = true;
  }
  function terminar(y) {
    if (inicioY.current == null) return;
    const delta = y - inicioY.current;
    inicioY.current = null;
    if (delta > 24 && !plegado) onCambiar(true);
    else if (delta < -24 && plegado) onCambiar(false);
  }

  // El toque simple (sin arrastre) también alterna; si hubo arrastre, el
  // gesto ya decidió en `terminar` y aquí no se vuelve a alternar.
  function alClick() {
    if (arrastrando.current) {
      arrastrando.current = false;
      return;
    }
    onCambiar(!plegado);
  }

  return (
    <button
      type="button"
      className="asa-panel"
      aria-label={plegado ? 'Mostrar panel' : 'Ocultar panel'}
      onClick={alClick}
      onMouseDown={(e) => empezar(e.clientY)}
      onMouseMove={(e) => mover(e.clientY)}
      onMouseUp={(e) => terminar(e.clientY)}
      onMouseLeave={() => {
        inicioY.current = null;
      }}
      onTouchStart={(e) => empezar(e.touches[0].clientY)}
      onTouchMove={(e) => mover(e.touches[0].clientY)}
      onTouchEnd={(e) => terminar(e.changedTouches[0].clientY)}
    >
      <span className="asa-barrita" />
    </button>
  );
}

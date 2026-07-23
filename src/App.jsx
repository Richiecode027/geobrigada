import React, { useEffect, useState } from 'react';
import { leerParametros } from './lib/links.js';
import { cargarRutaActiva } from './lib/storage.js';
import Coordinador from './views/Coordinador.jsx';
import Brigadas from './views/Brigadas.jsx';
import Brigadista from './views/Brigadista.jsx';
import Historial from './views/Historial.jsx';
import EnVivo from './views/EnVivo.jsx';
import Cobertura from './views/Cobertura.jsx';

const TABS = [
  { id: 'coordinador', titulo: 'Planear' },
  { id: 'envivo', titulo: 'En vivo' },
  { id: 'cobertura', titulo: 'Cobertura' },
  { id: 'historial', titulo: 'Historial' },
  { id: 'brigadas', titulo: 'Brigadas' }
];

export default function App() {
  // Dentro del APK, tocar otro link de brigadista con la app ya abierta
  // (main.jsx) avisa aquí en vez de recargar la página: se fuerza a releer
  // los parámetros de la URL, que main.jsx ya actualizó.
  const [, releerLink] = useState(0);
  useEffect(() => {
    const alCambiarLink = () => releerLink((n) => n + 1);
    window.addEventListener('geobrigada:link', alCambiarLink);
    return () => window.removeEventListener('geobrigada:link', alCambiarLink);
  }, []);

  // Si el link trae equipo asignado (?t=...), es un brigadista. Dentro del
  // APK, Android a veces reconstruye la pantalla desde cero (para liberar
  // memoria) aunque el GPS de fondo siga vivo; ahí la URL pierde los
  // parámetros, así que si no vienen en el link se usa la última ruta que
  // quedó en curso (ver guardarRutaActiva en Brigadista.jsx).
  const paramsLink = leerParametros();
  const params = paramsLink || cargarRutaActiva();
  const [tab, setTab] = useState('coordinador');
  // Contexto que la vista Brigadas pasa a Planear al tocar "Planear ▸" en una
  // colonia: lleva la colonia y las etiquetas (campaña, actividad, brigada).
  const [contextoPlanear, setContextoPlanear] = useState(null);

  // La "key" fuerza a React a desmontar y volver a montar Brigadista cuando
  // cambian los parámetros del link (otro equipo u otra colonia): sin esto,
  // reutiliza la misma pantalla y se queda con la ruta y el GPS del link
  // anterior — solo el título se vería actualizado.
  if (params) {
    return <Brigadista key={paramsLink ? window.location.search : 'ruta-activa'} params={params} />;
  }

  function planearColonia(contexto) {
    setContextoPlanear({ ...contexto, sello: Date.now() });
    setTab('coordinador');
  }

  return (
    <div className="app">
      <header className="encabezado">
        <h1>🗺️ GeoBrigada</h1>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'tab activa' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.titulo}
            </button>
          ))}
        </nav>
      </header>
      {tab === 'brigadas' && <Brigadas onPlanear={planearColonia} />}
      {tab === 'coordinador' && <Coordinador contexto={contextoPlanear} />}
      {tab === 'envivo' && <EnVivo />}
      {tab === 'cobertura' && <Cobertura />}
      {tab === 'historial' && <Historial />}
    </div>
  );
}

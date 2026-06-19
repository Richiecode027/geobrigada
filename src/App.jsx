import React, { useState } from 'react';
import { leerParametros } from './lib/links.js';
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
  // Si el link trae equipo asignado (?t=...), es un brigadista.
  const params = leerParametros();
  const [tab, setTab] = useState('coordinador');
  // Contexto que la vista Brigadas pasa a Planear al tocar "Planear ▸" en una
  // colonia: lleva la colonia y las etiquetas (campaña, actividad, brigada).
  const [contextoPlanear, setContextoPlanear] = useState(null);

  if (params) return <Brigadista params={params} />;

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

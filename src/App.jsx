import React, { useState } from 'react';
import { leerParametros } from './lib/links.js';
import Coordinador from './views/Coordinador.jsx';
import Brigadista from './views/Brigadista.jsx';
import Historial from './views/Historial.jsx';

export default function App() {
  // Si el link trae equipo asignado (?t=...), es un brigadista.
  const params = leerParametros();
  const [tab, setTab] = useState('coordinador');

  if (params) return <Brigadista params={params} />;

  return (
    <div className="app">
      <header className="encabezado">
        <h1>🗺️ GeoBrigada</h1>
        <nav>
          <button
            className={tab === 'coordinador' ? 'tab activa' : 'tab'}
            onClick={() => setTab('coordinador')}
          >
            Planear brigada
          </button>
          <button
            className={tab === 'historial' ? 'tab activa' : 'tab'}
            onClick={() => setTab('historial')}
          >
            Historial
          </button>
        </nav>
      </header>
      {tab === 'coordinador' ? <Coordinador /> : <Historial />}
    </div>
  );
}

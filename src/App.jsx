import React, { useState } from 'react';
import { leerParametros } from './lib/links.js';
import Coordinador from './views/Coordinador.jsx';
import Brigadista from './views/Brigadista.jsx';
import Historial from './views/Historial.jsx';
import EnVivo from './views/EnVivo.jsx';
import Cobertura from './views/Cobertura.jsx';

const TABS = [
  { id: 'coordinador', titulo: 'Planear' },
  { id: 'envivo', titulo: 'En vivo' },
  { id: 'cobertura', titulo: 'Cobertura' },
  { id: 'historial', titulo: 'Historial' }
];

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
      {tab === 'coordinador' && <Coordinador />}
      {tab === 'envivo' && <EnVivo />}
      {tab === 'cobertura' && <Cobertura />}
      {tab === 'historial' && <Historial />}
    </div>
  );
}

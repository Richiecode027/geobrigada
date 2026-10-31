// Datos del Censo 2020 (INEGI) de una zona del catálogo de colonias: viviendas
// habitadas (v), viviendas totales (vt, incluye deshabitadas y de uso
// temporal), población (p) y densidad (d, personas por km²). Los arma
// scripts/build-viviendas.mjs (v) y scripts/build-poblacion.mjs (vt, p, d).
//
// `c` es la zona tal como viene del catálogo (o null si no hay datos).
const fmt = (n) => Number(n || 0).toLocaleString('es-MX');

export default function DatosCenso({ c }) {
  if (!c || !(c.vt > 0 || c.p > 0 || c.dl)) return null;
  const otras = Math.max(0, (c.vt || 0) - (c.v || 0));
  return (
    <div className="aviso" style={{ background: '#f6f7fb', borderColor: '#d9dce8', fontSize: '0.85rem' }}>
      {/* Las secciones electorales (clave S…) traen sus distritos del INE. */}
      {c.dl && (
        <div style={{ marginBottom: 4 }}>
          🗳️ Distrito local <strong>{c.dl}</strong> · federal <strong>{c.df}</strong>
        </div>
      )}
      <strong>Censo INEGI 2020</strong>
      <div>🏠 Viviendas habitadas: <strong>{fmt(c.v)}</strong></div>
      <div>
        🏘️ Viviendas totales: <strong>{fmt(c.vt)}</strong>
        {otras > 0 && <span style={{ color: '#666' }}> ({fmt(otras)} deshabitadas o de uso temporal)</span>}
      </div>
      <div>👥 Personas: <strong>{fmt(c.p)}</strong></div>
      {c.d > 0 && (
        <div>
          📐 Densidad: <strong>{fmt(c.d)}</strong> personas por km²
        </div>
      )}
    </div>
  );
}

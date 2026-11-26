// Datos del Censo 2020 (INEGI) de una zona del catálogo de colonias: viviendas
// habitadas (v), viviendas totales (vt, incluye deshabitadas y de uso
// temporal), población (p) y densidad (d, personas por km²). Los arma
// scripts/build-viviendas.mjs (v) y scripts/build-poblacion.mjs (vt, p, d).
//
// `c` es la zona tal como viene del catálogo (o null si no hay datos).
// `partes` (opcional): cuando en Planear se juntan VARIAS colonias, la lista
// [{ k, n, datos }] de cada una — se enseña una tabla con el dato de cada
// colonia y la suma al final, en vez de solo el total.
const fmt = (n) => Number(n || 0).toLocaleString('es-MX');

// Densidad de varias colonias juntas: personas totales entre el área total
// (no el promedio de densidades, que le daría el mismo peso a una colonia
// chica que a una grande). El área de cada una sale de p / d.
function densidadJunta(lista) {
  let personas = 0;
  let km2 = 0;
  for (const c of lista) {
    if (c.d > 0 && c.p > 0) {
      personas += c.p;
      km2 += c.p / c.d;
    }
  }
  return km2 > 0 ? Math.round(personas / km2) : 0;
}

const celda = { padding: '3px 4px', textAlign: 'right', whiteSpace: 'nowrap' };
const celdaNombre = { padding: '3px 4px', textAlign: 'left' };

function TablaPorColonia({ partes }) {
  const filas = partes.map((p) => ({ k: p.k, n: p.n, ...(p.datos || {}) }));
  const suma = (campo) => filas.reduce((a, f) => a + (f[campo] || 0), 0);
  const total = { v: suma('v'), vt: suma('vt'), p: suma('p'), d: densidadJunta(filas) };
  const otras = Math.max(0, total.vt - total.v);
  return (
    <div className="aviso" style={{ background: '#f6f7fb', borderColor: '#d9dce8', fontSize: '0.8rem' }}>
      <strong>Censo INEGI 2020 · por colonia</strong>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #d9dce8', color: '#555' }}>
              <th style={celdaNombre}>Colonia</th>
              <th style={celda} title="Viviendas habitadas">🏠 Habit.</th>
              <th style={celda} title="Viviendas totales (habitadas + deshabitadas + uso temporal)">🏘️ Total</th>
              <th style={celda} title="Personas">👥 Pers.</th>
              <th style={celda} title="Personas por km²">📐 /km²</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.k} style={{ borderBottom: '1px solid #eceef5' }}>
                <td style={celdaNombre}>{f.n}</td>
                <td style={celda}>{fmt(f.v)}</td>
                <td style={celda}>{fmt(f.vt)}</td>
                <td style={celda}>{fmt(f.p)}</td>
                <td style={celda}>{f.d > 0 ? fmt(f.d) : '—'}</td>
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid #b9bdd0', fontWeight: 700 }}>
              <td style={celdaNombre}>Total</td>
              <td style={celda}>{fmt(total.v)}</td>
              <td style={celda}>{fmt(total.vt)}</td>
              <td style={celda}>{fmt(total.p)}</td>
              <td style={celda}>{total.d > 0 ? fmt(total.d) : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {otras > 0 && (
        <div style={{ color: '#666', marginTop: 4 }}>
          Del total, {fmt(otras)} viviendas están deshabitadas o son de uso temporal.
        </div>
      )}
    </div>
  );
}

export default function DatosCenso({ c, partes }) {
  if (partes && partes.length > 1) return <TablaPorColonia partes={partes} />;
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

import { useModelStore } from '../../store/modelStore'
import styles from './PropertiesPanel.module.css'

function fmt(v: number, digits = 4) {
  if (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-2 && v !== 0)) return v.toExponential(digits)
  return v.toPrecision(digits + 1)
}

const PROP_TYPE_LABEL: Record<string, string> = {
  PSOLID: '3-D Solid',
  PSHELL: 'Shell',
  PLPLANE: 'Plane',
  PBAR: 'Bar/Beam',
  PBEAM: 'Beam',
}

export function PropertiesPanel() {
  const nodes      = useModelStore(s => s.nodes)
  const elements   = useModelStore(s => s.elements)
  const materials  = useModelStore(s => s.materials)
  const properties = useModelStore(s => s.properties)

  const matName = (id: number) => materials.find(m => m.id === id)?.name ?? `Mat ${id}`

  return (
    <div className={styles.panel}>
      <div className={styles.title}>Model Info</div>

      <div className={styles.row}>
        <span className={styles.key}>Nodes</span>
        <span className={styles.val}>{nodes.length}</span>
      </div>
      <div className={styles.row}>
        <span className={styles.key}>Elements</span>
        <span className={styles.val}>{elements.length}</span>
      </div>

      {/* Materials table */}
      {materials.length > 0 && (
        <>
          <div className={styles.subtitle}>Materials</div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>E (Pa)</th>
                <th>ν</th>
                <th>ρ (kg/m³)</th>
              </tr>
            </thead>
            <tbody>
              {materials.map(m => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>{fmt(m.young)}</td>
                  <td>{m.poisson}</td>
                  <td>{m.density > 0 ? fmt(m.density) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* Properties table */}
      {properties.length > 0 && (
        <>
          <div className={styles.subtitle}>Sections</div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Type</th>
                <th>Material</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {properties.map(p => (
                <tr key={p.id}>
                  <td>{PROP_TYPE_LABEL[p.type] ?? p.type}</td>
                  <td>{matName(p.materialId)}</td>
                  <td>
                    {p.thickness != null ? `t=${fmt(p.thickness)} m` : ''}
                    {p.planeFormulation ? ` (${p.planeFormulation})` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

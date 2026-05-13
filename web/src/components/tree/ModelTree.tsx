import { useModelStore } from '../../store/modelStore'
import { groupConstraints, groupLoads } from '../../lib/parseAbaqus'
import { fmt, PROP_TYPE_LABEL } from '../../lib/modelDisplay'
import styles from './ModelTree.module.css'

export function ModelTree() {
  const nodes       = useModelStore(s => s.nodes)
  const elements    = useModelStore(s => s.elements)
  const materials   = useModelStore(s => s.materials)
  const properties  = useModelStore(s => s.properties)
  const constraints = useModelStore(s => s.constraints)
  const loads       = useModelStore(s => s.loads)

  // Count elements by type
  const elTypeCounts = elements.reduce<Record<string, number>>((acc, el) => {
    acc[el.type] = (acc[el.type] ?? 0) + 1
    return acc
  }, {})

  const bcGroups   = groupConstraints(constraints)
  const loadGroups = groupLoads(loads)

  // Build material name lookup
  const matName = (id: number) => materials.find(m => m.id === id)?.name ?? `Mat ${id}`

  return (
    <div className={styles.tree}>

      {/* ── Geometry ─────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.header}>Geometry</div>
        <div className={styles.item}>Nodes ({nodes.length})</div>
        <div className={styles.item}>
          Elements ({elements.length})
          {Object.entries(elTypeCounts).map(([t, n]) => (
            <span key={t} className={styles.badge}>{t}: {n}</span>
          ))}
        </div>
      </div>

      {/* ── Materials ────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.header}>Materials</div>
        {materials.length === 0
          ? <div className={styles.empty}>None</div>
          : materials.map(m => (
            <div key={m.id} className={styles.item}>
              <span className={styles.label}>{m.name}</span>
              <span className={styles.detail}>E = {fmt(m.young)} Pa</span>
              <span className={styles.detail}>ν = {m.poisson}</span>
              {m.density > 0 && <span className={styles.detail}>ρ = {fmt(m.density)} kg/m³</span>}
            </div>
          ))
        }
      </div>

      {/* ── Properties ───────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.header}>Sections / Properties</div>
        {properties.length === 0
          ? <div className={styles.empty}>None</div>
          : properties.map(p => (
            <div key={p.id} className={styles.item}>
              <span className={styles.label}>{PROP_TYPE_LABEL[p.type] ?? p.type}</span>
              <span className={styles.detail}>{matName(p.materialId)}</span>
              {p.thickness != null && <span className={styles.detail}>t = {fmt(p.thickness)} m</span>}
              {p.planeFormulation && <span className={styles.detail}>{p.planeFormulation}</span>}
            </div>
          ))
        }
      </div>

      {/* ── Boundary Conditions ──────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.header}>Boundary Conditions</div>
        {bcGroups.length === 0
          ? <div className={styles.empty}>None</div>
          : bcGroups.map((g) => (
            <div key={`${g.dofLabel}=${g.value}`} className={styles.item}>
              <span className={styles.bcIcon}>▣</span>
              <span className={styles.label}>{g.dofLabel} = {g.value}</span>
              <span className={styles.detail}>{g.nodeCount} node{g.nodeCount !== 1 ? 's' : ''}</span>
            </div>
          ))
        }
      </div>

      {/* ── Loads ────────────────────────────────────────────────── */}
      <div className={styles.section}>
        <div className={styles.header}>Loads</div>
        {loadGroups.length === 0
          ? <div className={styles.empty}>None</div>
          : loadGroups.map((g) => (
            <div key={g.dofLabel} className={styles.item}>
              <span className={styles.loadIcon}>↗</span>
              <span className={styles.label}>F{g.dofLabel} = {fmt(g.total)} N</span>
              <span className={styles.detail}>{g.nodeCount} node{g.nodeCount !== 1 ? 's' : ''}</span>
            </div>
          ))
        }
      </div>

    </div>
  )
}

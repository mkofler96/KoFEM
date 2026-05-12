import { useModelStore } from '../../store/modelStore'
import styles from './ModelTree.module.css'

export function ModelTree() {
  const nodes = useModelStore(s => s.nodes)
  const elements = useModelStore(s => s.elements)
  const materials = useModelStore(s => s.materials)

  return (
    <div className={styles.tree}>
      <div className={styles.section}>
        <div className={styles.header}>Geometry</div>
        <div className={styles.item}>Nodes ({nodes.length})</div>
        <div className={styles.item}>Elements ({elements.length})</div>
      </div>
      <div className={styles.section}>
        <div className={styles.header}>Materials</div>
        {materials.map(m => (
          <div key={m.id} className={styles.item}>{m.name}</div>
        ))}
      </div>
      <div className={styles.section}>
        <div className={styles.header}>Boundary Conditions</div>
      </div>
      <div className={styles.section}>
        <div className={styles.header}>Loads</div>
      </div>
    </div>
  )
}

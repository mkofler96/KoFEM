import { useModelStore } from '../../store/modelStore'
import styles from './StatusBar.module.css'

const MODE_LABELS: Record<string, string> = {
  geometry: 'Geometry', mesh: 'Mesh', constraints: 'Constraints', solve: 'Solve', results: 'Results',
}
const MODE_NUMS: Record<string, string> = {
  geometry: '01', mesh: '02', constraints: '03', solve: '04', results: '05',
}

export function StatusBar() {
  const mode        = useModelStore(s => s.mode)
  const nodes       = useModelStore(s => s.nodes)
  const elements    = useModelStore(s => s.elements)
  const constraints = useModelStore(s => s.constraints)
  const loads       = useModelStore(s => s.loads)
  const result      = useModelStore(s => s.result)
  const selectedFace = useModelStore(s => s.selectedFace)
  const pickMode    = useModelStore(s => s.pickMode)

  const hexCount = elements.filter(e => e.type === 'CHEXA').length
  const tetCount = elements.filter(e => e.type === 'CTETRA').length
  const meshOk = nodes.length > 0

  return (
    <div className={styles.bar}>
      {/* Left */}
      <div className={styles.left}>
        {/* <span className={styles.stepChip}>
          Step {MODE_NUMS[mode]} / 05 · {MODE_LABELS[mode]}
        </span> */}

        {pickMode && (
          <span className={styles.pickChip}>
            <span className={styles.pickDot} />
            {pickMode === 'bc' ? 'Pick face — fixed displacement' : 'Pick face — apply load'}
          </span>
        )}

        {selectedFace && !pickMode && (
          <span className={styles.selChip}>
            Selected: {selectedFace.label}
          </span>
        )}

        {nodes.length > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>{nodes.length} nodes</span>
          </>
        )}

        {hexCount > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>{hexCount} CHEXA</span>
          </>
        )}

        {tetCount > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>{tetCount} CTETRA</span>
          </>
        )}

        {constraints.length > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>{new Set(constraints.map(c => c.nodeId)).size} nodes fixed</span>
          </>
        )}

        {loads.length > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span className={styles.stat}>{loads.length} load DOFs</span>
          </>
        )}
      </div>

      {/* Right */}
      <div className={styles.right}>
        {result ? (
          <span className={styles.resultChip}>
            <span className={styles.okDot} />
            Solved · converged
          </span>
        ) : meshOk ? (
          <span className={styles.meshChip}>
            <span className={styles.okDot} />
            Mesh OK
          </span>
        ) : null}
        <span className={styles.muted}>m · N · Pa · v0.4.1</span>
      </div>
    </div>
  )
}

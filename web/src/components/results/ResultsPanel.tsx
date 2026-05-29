import { useModelStore } from '../../store/modelStore'
import styles from './ResultsPanel.module.css'

const MAX_X_TOL = 1e-6  // tolerance for finding nodes at the max-X face

const RESULT_TYPES = ['Displacement (magnitude)', 'Ux', 'Uy', 'Uz', 'Von Mises stress'] as const

export function ResultsPanel() {
  const result = useModelStore(s => s.result)
  const nodes = useModelStore(s => s.nodes)

  if (!result) {
    return (
      <div className={styles.panel}>
        <div className={styles.title}>Results</div>
        <div className={styles.empty}>No results — run the solver first</div>
      </div>
    )
  }


  const d = result.displacements
  const maxAbsDisp = Math.max(...Array.from(d).map(Math.abs))

  // Average Uy over nodes at the max-X face (within tolerance)
  const maxX = nodes.reduce((m, n) => Math.max(m, n.x), -Infinity)
  const tipNodes = nodes
    .map((n, i) => ({ i, n }))
    .filter(({ n }) => n.x >= maxX - MAX_X_TOL)
  const tipUy = tipNodes.length > 0
    ? tipNodes.reduce((sum, { i }) => sum + (d[i * 3 + 1] ?? 0), 0) / tipNodes.length
    : 0

  // CHEXA cantilever: P=10 kN, L=1 m, h=0.1 m square section → I = h⁴/12
  const P = 10_000, E = 210e9, h = 0.1
  const I = h ** 4 / 12
  const theory = -P / (3 * E * I)

  return (
    <div className={styles.panel}>
      <div className={styles.title}>Results</div>
      <select className={styles.select}>
        {RESULT_TYPES.map(t => <option key={t}>{t}</option>)}
      </select>
      <div className={styles.stat}>
        Max |displacement|: {maxAbsDisp.toExponential(3)} m
      </div>
      <div className={styles.stat}>
        Avg tip Uy: {tipUy.toExponential(4)} m
      </div>
      <div className={styles.stat}>
        Theory δ = PL³/3EI: {theory.toExponential(4)} m
      </div>
    </div>
  )
}

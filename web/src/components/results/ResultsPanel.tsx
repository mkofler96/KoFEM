import { useModelStore } from '../../store/modelStore'
import styles from './ResultsPanel.module.css'

const RESULT_TYPES = ['Displacement (magnitude)', 'Ux', 'Uy', 'Uz', 'Von Mises stress'] as const

export function ResultsPanel() {
  const result = useModelStore(s => s.result)

  if (!result) {
    return (
      <div className={styles.panel}>
        <div className={styles.title}>Results</div>
        <div className={styles.empty}>No results — run the solver first</div>
      </div>
    )
  }

  const d = result.displacements
  const n = d.length / 6
  const tipUy = d[(n - 1) * 6 + 1]
  const maxAbsDisp = Math.max(...Array.from(d).map(Math.abs))

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
        Tip Uy: {tipUy.toExponential(4)} m
      </div>
      <div className={styles.stat}>
        Theory δ = PL³/3EI: {(-1 / (3 * 210e9 * 8.333e-10)).toExponential(4)} m
      </div>
    </div>
  )
}

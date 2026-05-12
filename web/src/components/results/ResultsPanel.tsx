import React from 'react'
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

  return (
    <div className={styles.panel}>
      <div className={styles.title}>Results</div>
      <select className={styles.select}>
        {RESULT_TYPES.map(t => <option key={t}>{t}</option>)}
      </select>
      <div className={styles.stat}>
        Max displacement: {Math.max(...result.displacements).toExponential(3)} m
      </div>
    </div>
  )
}

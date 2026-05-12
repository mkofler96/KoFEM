import React from 'react'
import { useModelStore } from '../../store/modelStore'
import styles from './Toolbar.module.css'

export function Toolbar() {
  const isRunning = useModelStore(s => s.isRunning)
  const reset = useModelStore(s => s.reset)

  const handleSolve = () => {
    // TODO: dispatch solve message to Web Worker
    console.log('Solve triggered')
  }

  return (
    <div className={styles.toolbar}>
      <button className={styles.btn} title="Import mesh (*.bdf, *.inp, *.msh)">
        Import
      </button>
      <button className={styles.btn} title="Export results">
        Export
      </button>
      <div className={styles.divider} />
      <button className={`${styles.btn} ${styles.primary}`} onClick={handleSolve} disabled={isRunning}>
        {isRunning ? 'Solving…' : 'Solve'}
      </button>
      <button className={styles.btn} onClick={reset}>
        Reset
      </button>
    </div>
  )
}

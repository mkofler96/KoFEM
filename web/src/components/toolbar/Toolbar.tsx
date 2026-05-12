import { useRef } from 'react'
import { useModelStore } from '../../store/modelStore'
import styles from './Toolbar.module.css'

let msgId = 0

export function Toolbar() {
  const isRunning = useModelStore(s => s.isRunning)
  const reset = useModelStore(s => s.reset)
  const setRunning = useModelStore(s => s.setRunning)
  const setResult = useModelStore(s => s.setResult)

  const workerRef = useRef<Worker | null>(null)

  function getWorker() {
    if (!workerRef.current) {
      workerRef.current = new Worker(
        new URL('../../workers/solver.worker.ts', import.meta.url),
        { type: 'module' }
      )
      workerRef.current.onmessage = (e) => {
        const { ok, displacements, error } = e.data
        setRunning(false)
        if (ok) {
          setResult({ displacements: new Float64Array(displacements) })
        } else {
          console.error('Solver error:', error)
          alert(`Solver failed: ${error}`)
        }
      }
    }
    return workerRef.current
  }

  const handleSolve = () => {
    const state = useModelStore.getState()
    const payload = {
      nodes: state.nodes,
      elements: state.elements,
      materials: state.materials,
      properties: state.properties,
      constraints: state.constraints,
      loads: state.loads,
    }
    setRunning(true)
    const id = ++msgId
    getWorker().postMessage({ id, type: 'solve', payload })
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

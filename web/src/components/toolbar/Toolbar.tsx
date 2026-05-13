import { useRef } from 'react'
import { useModelStore } from '../../store/modelStore'
import { parseAbaqus } from '../../lib/parseAbaqus'
import styles from './Toolbar.module.css'

let msgId = 0

export function Toolbar() {
  const isRunning = useModelStore(s => s.isRunning)
  const modelName = useModelStore(s => s.modelName)
  const reset = useModelStore(s => s.reset)
  const setRunning = useModelStore(s => s.setRunning)
  const setResult = useModelStore(s => s.setResult)
  const loadModel = useModelStore(s => s.loadModel)

  const workerRef = useRef<Worker | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

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

  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''   // allow re-selecting the same file

    const text = await file.text()
    try {
      const model = parseAbaqus(text)
      if (model.nodes.length === 0) {
        alert('No nodes found in the file. Is this a valid Abaqus INP?')
        return
      }
      loadModel(model)
    } catch (err) {
      console.error('Parse error:', err)
      alert(`Failed to parse ${file.name}:\n${err}`)
    }
  }

  return (
    <div className={styles.toolbar}>
      <input
        ref={fileInputRef}
        type="file"
        accept=".inp"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      <button className={styles.btn} onClick={handleImportClick} disabled={isRunning} title="Import Abaqus INP file (*.inp)">
        Import
      </button>
      <button className={styles.btn} title="Export results" disabled>
        Export
      </button>
      <span className={styles.modelName}>{modelName}</span>
      <div className={styles.divider} />
      <button className={`${styles.btn} ${styles.primary}`} onClick={handleSolve} disabled={isRunning}>
        {isRunning ? 'Solving…' : 'Solve'}
      </button>
      <button className={styles.btn} onClick={reset} disabled={isRunning}>
        Reset
      </button>
    </div>
  )
}

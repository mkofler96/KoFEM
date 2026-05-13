import { useRef } from 'react'
import { useModelStore } from '../../store/modelStore'
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
        const { id: _id, ok, type: msgType, displacements, model, error } = e.data
        if (!ok) {
          setRunning(false)
          console.error('Worker error:', error)
          alert(`Error: ${error}`)
          return
        }
        if (msgType === 'parse' || model !== undefined) {
          if (model.nodes?.length === 0) {
            alert('No nodes found in the file. Is this a valid Abaqus INP?')
          } else {
            loadModel(model)
          }
        } else {
          setRunning(false)
          setResult({ displacements: new Float64Array(displacements) })
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
    getWorker().postMessage({ id: ++msgId, type: 'solve', payload })
  }

  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const text = await file.text()
    getWorker().postMessage({ id: ++msgId, type: 'parse', payload: { text } })
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

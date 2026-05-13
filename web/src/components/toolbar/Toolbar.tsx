import { useState, type ChangeEvent } from 'react'
import { useModelStore } from '../../store/modelStore'
import { sendToWorker } from '../../workers/sharedWorker'
import styles from './Toolbar.module.css'

export function Toolbar() {
  const isRunning = useModelStore(s => s.isRunning)
  const isMeshing = useModelStore(s => s.isMeshing)
  const modelName = useModelStore(s => s.modelName)
  const reset = useModelStore(s => s.reset)
  const setRunning = useModelStore(s => s.setRunning)
  const setResult = useModelStore(s => s.setResult)
  const loadModel = useModelStore(s => s.loadModel)

  const [isParsing, setIsParsing] = useState(false)
  const fileInputRef = { current: null as HTMLInputElement | null }

  const handleSolve = () => {
    const state = useModelStore.getState()
    setRunning(true)
    sendToWorker<{ displacements: number[] }>('solve', {
      nodes: state.nodes,
      elements: state.elements,
      materials: state.materials,
      properties: state.properties,
      constraints: state.constraints,
      loads: state.loads,
    })
      .then(({ displacements }) => setResult({ displacements: new Float64Array(displacements) }))
      .catch(err => alert(`Solver error: ${err.message}`))
      .finally(() => setRunning(false))
  }

  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setIsParsing(true)
    setRunning(true)
    const text = await file.text()
    sendToWorker<{ model: Parameters<typeof loadModel>[0] }>('parse', { text })
      .then(({ model }) => {
        if ((model.nodes?.length ?? 0) === 0) {
          alert('No nodes found in the file. Is this a valid Abaqus INP?')
        } else {
          loadModel(model)
        }
      })
      .catch(err => alert(`Parse error: ${err.message}`))
      .finally(() => { setIsParsing(false); setRunning(false) })
  }

  const busy = isRunning || isMeshing

  return (
    <div className={styles.toolbar}>
      <input
        ref={el => { fileInputRef.current = el }}
        type="file"
        accept=".inp"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
      <button className={styles.btn} onClick={handleImportClick} disabled={busy} title="Import Abaqus INP file (*.inp)">
        {isParsing ? 'Parsing…' : 'Import'}
      </button>
      <button className={styles.btn} title="Export results" disabled>
        Export
      </button>
      <span className={styles.modelName}>{modelName}</span>
      <div className={styles.divider} />
      <button className={`${styles.btn} ${styles.primary}`} onClick={handleSolve} disabled={busy}>
        {isRunning && !isParsing ? 'Solving…' : 'Solve'}
      </button>
      <button className={styles.btn} onClick={reset} disabled={busy}>
        Reset
      </button>
    </div>
  )
}

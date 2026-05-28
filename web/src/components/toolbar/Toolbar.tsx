import { useState, type ChangeEvent } from 'react'
import { useModelStore } from '../../store/modelStore'
import { sendToWorker } from '../../workers/sharedWorker'
import { ReportProgress } from '../report/ReportProgress'
import styles from './Toolbar.module.css'

export function Toolbar() {
  const isRunning = useModelStore(s => s.isRunning)
  const isMeshing = useModelStore(s => s.isMeshing)
  const modelName = useModelStore(s => s.modelName)
  const reset = useModelStore(s => s.reset)
  const setRunning = useModelStore(s => s.setRunning)
  const setResult = useModelStore(s => s.setResult)
  const loadModel = useModelStore(s => s.loadModel)
  const setStepSurface = useModelStore(s => s.setStepSurface)
  const triggerFitView = useModelStore(s => s.triggerFitView)
  const stepSurface = useModelStore(s => s.stepSurface)
  const stepWireframe = useModelStore(s => s.stepWireframe)
  const setStepWireframe = useModelStore(s => s.setStepWireframe)
  const volMesh = useModelStore(s => s.volMesh)
  const showVolMesh = useModelStore(s => s.showVolMesh)
  const setVolMesh = useModelStore(s => s.setVolMesh)
  const setShowVolMesh = useModelStore(s => s.setShowVolMesh)
  const stepImportError = useModelStore(s => s.stepImportError)
  const setStepImportError = useModelStore(s => s.setStepImportError)

  const [isParsing, setIsParsing] = useState(false)
  const [isImportingStep, setIsImportingStep] = useState(false)
  const [isComputingVol, setIsComputingVol] = useState(false)
  const [isGeneratingReport, setIsGeneratingReport] = useState(false)

  const handleScreenshot = () => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement | null
    if (!canvas) return
    const link = document.createElement('a')
    link.download = `kofem-${modelName.replace(/[^a-zA-Z0-9]/g, '-')}.png`
    link.href = canvas.toDataURL('image/png')
    link.click()
  }
  const inpFileRef = { current: null as HTMLInputElement | null }
  const stepFileRef = { current: null as HTMLInputElement | null }

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

  const handleImportInpClick = () => { inpFileRef.current?.click() }
  const handleImportStepClick = () => { stepFileRef.current?.click() }

  const handleInpFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
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

  const handleComputeVolMesh = () => {
    if (!stepSurface) return
    setIsComputingVol(true)
    sendToWorker<{ points: [number, number, number][]; edges: [number, number][] }>(
      'volume_mesh', { surface: stepSurface }
    )
      .then(({ points, edges }) => setVolMesh({ points, edges }))
      .catch(err => alert(`Volume meshing failed: ${err.message}`))
      .finally(() => setIsComputingVol(false))
  }

  const handleStepFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setStepImportError(null)
    setIsImportingStep(true)
    setRunning(true)
    const bytes = new Uint8Array(await file.arrayBuffer())
    sendToWorker<{ points: [number, number, number][]; triangles: [number, number, number][] }>(
      'parse_step', { bytes }
    )
      .then(({ points, triangles }) => {
        if (points.length === 0) {
          setStepImportError('No geometry found in STEP file.')
        } else {
          setStepSurface({ points, triangles })
        }
      })
      .catch(err => setStepImportError(err.message ?? 'STEP import failed'))
      .finally(() => { setIsImportingStep(false); setRunning(false) })
  }

  const busy = isRunning || isMeshing

  return (
    <>
    {isGeneratingReport && <ReportProgress onClose={() => setIsGeneratingReport(false)} />}
    {stepImportError && (
      <div
        role="alert"
        data-testid="step-error"
        style={{ background: '#c0392b', color: '#fff', padding: '6px 12px', fontSize: '13px', display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <span style={{ flex: 1 }}>STEP import failed: {stepImportError}</span>
        <button
          onClick={() => setStepImportError(null)}
          aria-label="Dismiss error"
          style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}
        >×</button>
      </div>
    )}
    <div className={styles.toolbar}>
      <input
        ref={el => { inpFileRef.current = el }}
        type="file"
        accept=".inp"
        style={{ display: 'none' }}
        onChange={handleInpFileChange}
      />
      <input
        ref={el => { stepFileRef.current = el }}
        type="file"
        accept=".stp,.step"
        style={{ display: 'none' }}
        onChange={handleStepFileChange}
      />
      <button className={styles.btn} onClick={handleImportInpClick} disabled={busy} title="Import Abaqus INP file (*.inp)">
        {isParsing ? 'Parsing…' : 'Import INP'}
      </button>
      <button className={styles.btn} onClick={handleImportStepClick} disabled={busy} title="Import STEP geometry file (*.stp, *.step)">
        {isImportingStep ? 'Importing…' : 'Import STEP'}
      </button>
      <button className={styles.btn} title="Export results" disabled>
        Export
      </button>
      <button
        className={styles.btn}
        title="Generate PDF report of mesh capabilities"
        onClick={() => setIsGeneratingReport(true)}
        disabled={busy || isGeneratingReport}
      >
        Report
      </button>
      {stepSurface && (
        <button
          className={`${styles.btn} ${stepWireframe ? styles.active : ''}`}
          onClick={() => setStepWireframe(!stepWireframe)}
          title="Toggle surface mesh wireframe"
        >
          {stepWireframe ? 'Solid' : 'Wireframe'}
        </button>
      )}
      {stepSurface && !volMesh && (
        <button
          className={styles.btn}
          onClick={handleComputeVolMesh}
          disabled={busy || isComputingVol}
          title="Compute interior tetrahedral volume mesh"
        >
          {isComputingVol ? 'Meshing…' : 'Vol Mesh'}
        </button>
      )}
      {volMesh && (
        <button
          className={`${styles.btn} ${showVolMesh ? styles.active : ''}`}
          onClick={() => setShowVolMesh(!showVolMesh)}
          title="Toggle volume mesh wireframe"
        >
          {showVolMesh ? 'Vol Solid' : 'Vol Mesh'}
        </button>
      )}
      <button className={styles.btn} onClick={triggerFitView} title="Fit all geometry into view (isometric)">
        Fit View
      </button>
      <button className={styles.btn} onClick={handleScreenshot} title="Export current view as PNG">
        Screenshot
      </button>
      <span className={styles.modelName}>{modelName}</span>
      <div className={styles.divider} />
      <button className={`${styles.btn} ${styles.primary}`} onClick={handleSolve} disabled={busy}>
        {isRunning && !isParsing && !isImportingStep ? 'Solving…' : 'Solve'}
      </button>
      <button className={styles.btn} onClick={reset} disabled={busy}>
        Reset
      </button>
    </div>
    </>
  )
}

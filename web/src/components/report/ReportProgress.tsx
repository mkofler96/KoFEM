import { useEffect, useState } from 'react'
import { useModelStore } from '../../store/modelStore'
import { generateMeshReport, type ReportStep, type ReportModel } from '../../lib/generateReport'
import styles from './ReportProgress.module.css'

interface Step { id: ReportStep; label: string }

const STEPS: Step[] = [
  { id: 'collecting', label: 'Collecting model data' },
  { id: 'statistics', label: 'Computing mesh statistics' },
  { id: 'elements',   label: 'Rendering element library' },
  { id: 'materials',  label: 'Building materials section' },
  { id: 'building',   label: 'Generating PDF pages' },
  { id: 'done',       label: 'Download ready' },
]

interface Props {
  onClose: () => void
}

export function ReportProgress({ onClose }: Props) {
  const [currentStep, setCurrentStep] = useState<ReportStep>('collecting')
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const state: ReportModel = useModelStore.getState()
    const safeName = state.modelName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase()
    const filename = `kofem-report-${safeName}.pdf`

    generateMeshReport(state, (step, prog) => {
      setCurrentStep(step)
      setProgress(prog)
    })
      .then(blob => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        setTimeout(onClose, 1200)
      })
      .catch(err => {
        console.error('Report generation failed', err)
        onClose()
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const currentIdx = STEPS.findIndex(s => s.id === currentStep)
  const done = progress >= 100
  const modelName = useModelStore(s => s.modelName)
  const filename = `kofem-report-${modelName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase()}.pdf`

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        <div className={styles.header}>
          <div className={styles.fileIconWrap}>
            <div className={styles.fileIconBase}>
              <span className={styles.fileIconLabel}>PDF</span>
            </div>
            <div className={styles.fileIconCorner} />
          </div>
          <div className={styles.headerText}>
            <span className={styles.filename}>{filename}</span>
            <span className={styles.status}>{done ? 'Download started' : 'Generating…'}</span>
          </div>
        </div>

        <div className={styles.progressTrack}>
          <div
            className={`${styles.progressFill} ${done ? styles.complete : ''}`}
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className={styles.steps}>
          {STEPS.map((step, idx) => {
            const isDone = idx < currentIdx || done
            const isActive = !done && step.id === currentStep
            return (
              <div
                key={step.id}
                className={`${styles.step} ${isDone ? styles.done : ''} ${isActive ? styles.active : ''}`}
              >
                <span className={styles.icon}>
                  {isDone
                    ? <span className={styles.iconCheck}>✓</span>
                    : isActive
                      ? <span className={styles.iconSpinner} />
                      : <span className={styles.iconDot} />}
                </span>
                {step.label}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

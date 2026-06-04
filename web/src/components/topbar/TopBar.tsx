import { useModelStore } from '../../store/modelStore'
import type { AppMode } from '../../store/modelStore'
import styles from './TopBar.module.css'

const MODES: { id: AppMode; label: string }[] = [
  { id: 'geometry',    label: 'Geometry'    },
  { id: 'mesh',        label: 'Mesh'        },
  { id: 'constraints', label: 'Constraints' },
  { id: 'solve',       label: 'Solve'       },
  { id: 'results',     label: 'Results'     },
]

export function TopBar() {
  const mode    = useModelStore(s => s.mode)
  const setMode = useModelStore(s => s.setMode)
  const modelName  = useModelStore(s => s.modelName)
  const nodes      = useModelStore(s => s.nodes)
  const constraints = useModelStore(s => s.constraints)
  const loads      = useModelStore(s => s.loads)
  const result     = useModelStore(s => s.result)

  function statusFor(m: AppMode): 'active' | 'future' {
    if (m === mode) return 'active'
    return 'future'
  }

  function isValid(m: AppMode): boolean {
    if (m === 'geometry' || m === 'mesh') return nodes.length > 0
    if (m === 'constraints') return constraints.length > 0 || loads.length > 0
    if (m === 'solve' || m === 'results') return result !== null
    return false
  }

  return (
    <header className={styles.bar}>
      {/* Brand */}
      <div className={styles.brand}>
        <div className={styles.mark}>K</div>
        <span className={styles.name}>KoFEM</span>
        <span className={styles.crumb}>
          <span className={styles.crumbMuted}>Workspace</span>
          <span className={styles.crumbSep}>/</span>
          <span className={styles.crumbPage}>{modelName || 'Untitled'}</span>
        </span>
      </div>

      {/* Mode tabs */}
      <nav className={styles.modes}>
        {MODES.map(({ id, label }) => {
          const status = statusFor(id)
          const valid  = isValid(id)
          return (
            <button
              key={id}
              className={`${styles.tab} ${status === 'active' ? styles.tabActive : styles.tabFuture}`}
              onClick={() => setMode(id)}
            >
              {valid ? (
                <span className={`${styles.dot} ${styles.dotDone}`}>
                  <svg viewBox="0 0 8 8" width="5" height="5">
                    <path d="M1.5 4L3 5.5L6.5 2" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round"/>
                  </svg>
                </span>
              ) : (
                <span className={styles.dot} />
              )}
              <span className={styles.tabLabel}>{label}</span>
            </button>
          )
        })}
      </nav>

      {/* Right */}
      <div className={styles.right}>
        <span className={styles.units}><b>SI</b> · m, N, Pa</span>
        <button className={styles.iconBtn} title="Settings" onClick={() => {}} aria-label="Settings">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4"/>
            <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
              stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </button>
        <div className={styles.avatar}>K</div>
      </div>
    </header>
  )
}

import { useState } from 'react'
import { useModelStore } from '../../store/modelStore'
import styles from './FacePickPanel.module.css'

const DOF_LABELS = ['Ux', 'Uy', 'Uz', 'Rx', 'Ry', 'Rz']
const DOF_LOAD_LABELS = ['Fx', 'Fy', 'Fz', 'Mx', 'My', 'Mz']

export function FacePickPanel() {
  const pickMode = useModelStore(s => s.pickMode)
  const selectedFace = useModelStore(s => s.selectedFace)
  const setPickMode = useModelStore(s => s.setPickMode)
  const setSelectedFace = useModelStore(s => s.setSelectedFace)
  const applyBcToFace = useModelStore(s => s.applyBcToFace)
  const applyLoadToFace = useModelStore(s => s.applyLoadToFace)

  const [checkedDofs, setCheckedDofs] = useState<boolean[]>([true, true, true, false, false, false])
  const [bcValue, setBcValue] = useState('0')
  const [loadDof, setLoadDof] = useState(1)
  const [loadForce, setLoadForce] = useState('-10000')

  if (!pickMode) return null

  function handleCancel() {
    setPickMode(null)
    setSelectedFace(null)
  }

  function toggleDof(i: number) {
    setCheckedDofs(prev => prev.map((v, j) => j === i ? !v : v))
  }

  function handleApplyBc() {
    if (!selectedFace) return
    const dofs = checkedDofs.map((c, i) => c ? i : -1).filter(i => i >= 0)
    applyBcToFace(selectedFace.nodeIds, dofs, parseFloat(bcValue) || 0)
    setPickMode(null)
    setSelectedFace(null)
  }

  function handleApplyLoad() {
    if (!selectedFace) return
    applyLoadToFace(selectedFace.nodeIds, loadDof, parseFloat(loadForce) || 0)
    setPickMode(null)
    setSelectedFace(null)
  }

  return (
    <div className={styles.panel}>
      <div className={styles.title}>
        {pickMode === 'bc' ? '▣ Apply Boundary Condition' : '↗ Apply Load'}
      </div>

      {!selectedFace ? (
        <p className={styles.instruction}>
          Click a face on the mesh in the 3D viewport to select it.
        </p>
      ) : (
        <div className={styles.selectedFace}>{selectedFace.label}</div>
      )}

      {pickMode === 'bc' && selectedFace && (
        <>
          <div className={styles.sectionLabel}>Fix DOFs</div>
          <div className={styles.dofGrid}>
            {DOF_LABELS.map((d, i) => (
              <label key={d} className={styles.dofCheck}>
                <input type="checkbox" checked={checkedDofs[i]} onChange={() => toggleDof(i)} />
                {d}
              </label>
            ))}
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Value</span>
            <input
              className={styles.input}
              type="number"
              value={bcValue}
              onChange={e => setBcValue(e.target.value)}
              step="0.001"
            />
          </div>
        </>
      )}

      {pickMode === 'load' && selectedFace && (
        <>
          <div className={styles.sectionLabel}>Force</div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>DOF</span>
            <select className={styles.select} value={loadDof} onChange={e => setLoadDof(Number(e.target.value))}>
              {DOF_LOAD_LABELS.map((d, i) => (
                <option key={d} value={i}>{d}</option>
              ))}
            </select>
          </div>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Total (N)</span>
            <input
              className={styles.input}
              type="number"
              value={loadForce}
              onChange={e => setLoadForce(e.target.value)}
              step="100"
            />
          </div>
          {selectedFace && (
            <div className={styles.note}>
              {selectedFace.nodeIds.length} nodes →{' '}
              {(parseFloat(loadForce) / selectedFace.nodeIds.length).toFixed(1)} N/node
            </div>
          )}
        </>
      )}

      <div className={styles.footer}>
        <button className={styles.cancelBtn} onClick={handleCancel}>Cancel</button>
        {selectedFace && (
          <button
            className={`${styles.applyBtn} ${pickMode === 'load' ? styles.applyBtnLoad : ''}`}
            onClick={pickMode === 'bc' ? handleApplyBc : handleApplyLoad}
          >
            Apply
          </button>
        )}
      </div>
    </div>
  )
}

import { useState } from 'react'
import type { BoxGeometry } from '../../store/modelStore'
import styles from './GeometryDialog.module.css'

interface Props {
  geometry?: BoxGeometry
  onClose(): void
  onSave(g: Omit<BoxGeometry, 'id'>): void
}

const SKETCH_NORMAL_LABELS: Record<string, string> = {
  X: 'YZ plane (normal X)',
  Y: 'XZ plane (normal Y)',
  Z: 'XY plane (normal Z)',
}

const SKETCH_AXIS_LABELS: Record<string, [string, string]> = {
  X: ['Y', 'Z'],  // [width axis, height axis]
  Y: ['X', 'Z'],
  Z: ['X', 'Y'],
}

export function GeometryDialog({ geometry, onClose, onSave }: Props) {
  const [name, setName] = useState(geometry?.name ?? 'Box')
  const [ox, setOx] = useState(String(geometry?.ox ?? 0))
  const [oy, setOy] = useState(String(geometry?.oy ?? 0))
  const [oz, setOz] = useState(String(geometry?.oz ?? 0))
  const [sketchNormal, setSketchNormal] = useState<'X' | 'Y' | 'Z'>(geometry?.sketchNormal ?? 'X')
  const [sketchWidth, setSketchWidth] = useState(String(geometry?.sketchWidth ?? 0.1))
  const [sketchHeight, setSketchHeight] = useState(String(geometry?.sketchHeight ?? 0.1))
  const [extrudeSign, setExtrudeSign] = useState<1 | -1>(geometry?.extrudeSign ?? 1)
  const [extrudeLength, setExtrudeLength] = useState(String(geometry?.extrudeLength ?? 1.0))
  const [meshNu, setMeshNu] = useState(String(geometry?.meshNu ?? 2))
  const [meshNv, setMeshNv] = useState(String(geometry?.meshNv ?? 2))
  const [meshNw, setMeshNw] = useState(String(geometry?.meshNw ?? 10))

  const nu = Math.max(1, parseInt(meshNu) || 1)
  const nv = Math.max(1, parseInt(meshNv) || 1)
  const nw = Math.max(1, parseInt(meshNw) || 1)
  const nNodes = (nu + 1) * (nv + 1) * (nw + 1)
  const nElems = nu * nv * nw

  const [wa, ha] = SKETCH_AXIS_LABELS[sketchNormal]

  function handleSave() {
    onSave({
      name: name || 'Box',
      ox: parseFloat(ox) || 0,
      oy: parseFloat(oy) || 0,
      oz: parseFloat(oz) || 0,
      sketchNormal,
      sketchWidth: parseFloat(sketchWidth) || 0.1,
      sketchHeight: parseFloat(sketchHeight) || 0.1,
      extrudeSign,
      extrudeLength: Math.abs(parseFloat(extrudeLength) || 1),
      meshNu: nu,
      meshNv: nv,
      meshNw: nw,
    })
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={e => e.stopPropagation()}>
        <div className={styles.title}>{geometry ? `Edit — ${geometry.name}` : 'New Geometry'}</div>

        {/* Name */}
        <div className={styles.row}>
          <span className={styles.label}>Name</span>
          <input className={styles.input} value={name} onChange={e => setName(e.target.value)} />
        </div>

        {/* Origin */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Origin (Point)</div>
          <div className={styles.row}>
            <span className={styles.label}>X</span>
            <input className={styles.input} type="number" value={ox} onChange={e => setOx(e.target.value)} step="0.1" />
            <span className={styles.unit}>m</span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Y</span>
            <input className={styles.input} type="number" value={oy} onChange={e => setOy(e.target.value)} step="0.1" />
            <span className={styles.unit}>m</span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Z</span>
            <input className={styles.input} type="number" value={oz} onChange={e => setOz(e.target.value)} step="0.1" />
            <span className={styles.unit}>m</span>
          </div>
        </div>

        {/* Sketch */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Sketch (Rectangle)</div>
          <div className={styles.row}>
            <span className={styles.label}>Plane</span>
            <select
              className={styles.select}
              value={sketchNormal}
              onChange={e => setSketchNormal(e.target.value as 'X' | 'Y' | 'Z')}
            >
              <option value="X">{SKETCH_NORMAL_LABELS.X}</option>
              <option value="Y">{SKETCH_NORMAL_LABELS.Y}</option>
              <option value="Z">{SKETCH_NORMAL_LABELS.Z}</option>
            </select>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Width ({wa})</span>
            <input className={styles.input} type="number" value={sketchWidth} onChange={e => setSketchWidth(e.target.value)} step="0.01" min="0.001" />
            <span className={styles.unit}>m</span>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Height ({ha})</span>
            <input className={styles.input} type="number" value={sketchHeight} onChange={e => setSketchHeight(e.target.value)} step="0.01" min="0.001" />
            <span className={styles.unit}>m</span>
          </div>
        </div>

        {/* Extrude */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Extrude (along {sketchNormal})</div>
          <div className={styles.row}>
            <span className={styles.label}>Direction</span>
            <div className={styles.dirToggle}>
              <button
                className={`${styles.dirBtn} ${extrudeSign === 1 ? styles.dirBtnActive : ''}`}
                onClick={() => setExtrudeSign(1)}
              >+{sketchNormal}</button>
              <button
                className={`${styles.dirBtn} ${extrudeSign === -1 ? styles.dirBtnActive : ''}`}
                onClick={() => setExtrudeSign(-1)}
              >−{sketchNormal}</button>
            </div>
          </div>
          <div className={styles.row}>
            <span className={styles.label}>Length</span>
            <input className={styles.input} type="number" value={extrudeLength} onChange={e => setExtrudeLength(e.target.value)} step="0.1" min="0.001" />
            <span className={styles.unit}>m</span>
          </div>
        </div>

        {/* Mesh */}
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Mesh Divisions (CHEXA8)</div>
          <div className={styles.row}>
            <span className={styles.label}>N{wa} (width)</span>
            <input className={styles.input} type="number" value={meshNu} onChange={e => setMeshNu(e.target.value)} min="1" step="1" />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>N{ha} (height)</span>
            <input className={styles.input} type="number" value={meshNv} onChange={e => setMeshNv(e.target.value)} min="1" step="1" />
          </div>
          <div className={styles.row}>
            <span className={styles.label}>N{sketchNormal} (depth)</span>
            <input className={styles.input} type="number" value={meshNw} onChange={e => setMeshNw(e.target.value)} min="1" step="1" />
          </div>
          <div className={styles.previewLine}>
            {nNodes} nodes · {nElems} CHEXA8 elements
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.btnSecondary} onClick={onClose}>Cancel</button>
          <button className={styles.btnPrimary} onClick={handleSave}>
            {geometry ? 'Update' : 'Create & Mesh'}
          </button>
        </div>
      </div>
    </div>
  )
}

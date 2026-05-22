import { useState } from 'react'
import { useModelStore } from '../../store/modelStore'
import styles from './WelcomeScreen.module.css'

function NumInput({
  label, value, onChange, step = '1', min = '0.001', unit,
}: {
  label: string; value: string; onChange(v: string): void
  step?: string; min?: string; unit?: string
}) {
  return (
    <div className={styles.formRow}>
      <label className={styles.formLabel}>{label}</label>
      <div className={styles.inputWrap}>
        <input
          className={styles.formInput}
          type="number"
          value={value}
          step={step}
          min={min}
          onChange={e => onChange(e.target.value)}
        />
        {unit && <span className={styles.unit}>{unit}</span>}
      </div>
    </div>
  )
}

export function WelcomeScreen() {
  const startWithExample = useModelStore(s => s.startWithExample)
  const startCustom = useModelStore(s => s.startCustom)

  const [name, setName] = useState('My Model')
  const [lx, setLx] = useState('1.0')
  const [ly, setLy] = useState('0.1')
  const [lz, setLz] = useState('0.1')
  const [nx, setNx] = useState('10')
  const [ny, setNy] = useState('2')
  const [nz, setNz] = useState('2')

  const nNodes = (parseInt(nx) + 1) * (parseInt(ny) + 1) * (parseInt(nz) + 1)
  const nElems = parseInt(nx) * parseInt(ny) * parseInt(nz)

  function handleCreate() {
    startCustom({
      name: name || 'Model',
      lx: parseFloat(lx) || 1.0,
      ly: parseFloat(ly) || 0.1,
      lz: parseFloat(lz) || 0.1,
      nx: Math.max(1, parseInt(nx) || 10),
      ny: Math.max(1, parseInt(ny) || 2),
      nz: Math.max(1, parseInt(nz) || 2),
    })
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.card}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.logoRow}>
            <div className={styles.logoMark}>K</div>
            <span className={styles.logoName}>KoFEM</span>
          </div>
          <p className={styles.tagline}>Finite element analysis · in your browser</p>
        </div>

        {/* Example button */}
        <button className={styles.exampleBtn} onClick={startWithExample}>
          <div className={styles.exampleIcon}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6 3.5L11.5 8L6 12.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div className={styles.exampleText}>
            <span className={styles.exampleTitle}>Start with example</span>
            <span className={styles.exampleDesc}>Cantilever beam · 1.0 × 0.1 × 0.1 m · Steel · F<sub>y</sub> = −10 kN</span>
          </div>
          <span className={styles.exampleBadge}>CHEXA8 · 75 N · 40 E</span>
        </button>

        {/* Divider */}
        <div className={styles.divider}>
          <span>or define a new model</span>
        </div>

        {/* Form */}
        <div className={styles.form}>
          <div className={styles.formRow}>
            <label className={styles.formLabel}>Name</label>
            <div className={styles.inputWrap}>
              <input
                className={styles.formInput}
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                placeholder="Model name"
              />
            </div>
          </div>

          <div className={styles.formGroup}>
            <div className={styles.groupTitle}>Dimensions</div>
            <NumInput label="Length X" value={lx} onChange={setLx} step="0.1" unit="m" />
            <NumInput label="Width Y"  value={ly} onChange={setLy} step="0.01" unit="m" />
            <NumInput label="Height Z" value={lz} onChange={setLz} step="0.01" unit="m" />
          </div>

          <div className={styles.formGroup}>
            <div className={styles.groupTitle}>Mesh divisions (CHEXA8)</div>
            <NumInput label="Along X" value={nx} onChange={setNx} step="1" min="1" />
            <NumInput label="Along Y" value={ny} onChange={setNy} step="1" min="1" />
            <NumInput label="Along Z" value={nz} onChange={setNz} step="1" min="1" />
            <div className={styles.meshPreview}>
              {isNaN(nNodes) ? '—' : nNodes} nodes · {isNaN(nElems) ? '—' : nElems} elements
            </div>
          </div>

          <button className={styles.createBtn} onClick={handleCreate}>
            Create &amp; Mesh
          </button>
        </div>
      </div>
    </div>
  )
}

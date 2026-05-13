import { useState } from 'react'
import { useModelStore, type BoxGeometry, type Material, type Node, type Element } from '../../store/modelStore'
import { GeometryDialog } from '../geometry/GeometryDialog'
import { groupConstraints, groupLoads } from '../../lib/parseAbaqus'
import { fmt } from '../../lib/modelDisplay'
import { sendToWorker } from '../../workers/sharedWorker'
import styles from './Sidebar.module.css'

// ── Geometry ──────────────────────────────────────────────────────────────────

function GeometrySection() {
  const geometries = useModelStore(s => s.geometries)
  const addGeometry = useModelStore(s => s.addGeometry)
  const updateGeometry = useModelStore(s => s.updateGeometry)
  const deleteGeometry = useModelStore(s => s.deleteGeometry)
  const setMeshing = useModelStore(s => s.setMeshing)
  const applyMeshResult = useModelStore(s => s.applyMeshResult)
  const isMeshing = useModelStore(s => s.isMeshing)
  const nodes = useModelStore(s => s.nodes)
  const elements = useModelStore(s => s.elements)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<BoxGeometry | null>(null)

  function openCreate() { setEditing(null); setDialogOpen(true) }
  function openEdit(g: BoxGeometry) { setEditing(g); setDialogOpen(true) }

  function handleSave(params: Omit<BoxGeometry, 'id'>) {
    if (editing) {
      updateGeometry(editing.id, params)
    } else {
      addGeometry(params)
    }
    setDialogOpen(false)
  }

  async function runMesh(geom: BoxGeometry) {
    setMeshing(true)
    try {
      const { nodes, elements } = await sendToWorker<{ nodes: Node[]; elements: Element[] }>('mesh', geom)
      applyMeshResult(nodes, elements, geom.name)
    } catch (err) {
      alert(`Meshing failed: ${err}`)
    } finally {
      setMeshing(false)
    }
  }

  function handleCreateAndMesh(params: Omit<BoxGeometry, 'id'>) {
    addGeometry(params)
    const store = useModelStore.getState()
    const newGeom = store.geometries[store.geometries.length - 1]
    if (newGeom) runMesh(newGeom)
    setDialogOpen(false)
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span>Geometry</span>
        <button className={styles.addBtn} onClick={openCreate} title="Add geometry">+</button>
      </div>

      {geometries.length === 0 && (
        <div className={styles.empty}>No geometry — click + to add</div>
      )}

      {geometries.map(g => (
        <div key={g.id} className={styles.item}>
          <div>
            <div className={styles.itemName}>{g.name}</div>
            <div className={styles.itemDetail}>
              {g.sketchWidth}×{g.sketchHeight}×{g.extrudeLength} m
              {nodes.length > 0 && <span className={styles.badge}>{nodes.length}N</span>}
              {elements.length > 0 && <span className={styles.badge}>{elements.length}E</span>}
            </div>
          </div>
          <div className={styles.itemActions}>
            <button
              className={styles.iconBtn}
              title="Remesh"
              disabled={isMeshing}
              onClick={() => runMesh(g)}
            >⟳</button>
            <button
              className={styles.iconBtn}
              title="Edit"
              onClick={() => openEdit(g)}
            >✎</button>
            <button
              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
              title="Delete"
              onClick={() => deleteGeometry(g.id)}
            >×</button>
          </div>
        </div>
      ))}

      {dialogOpen && (
        <GeometryDialog
          geometry={editing ?? undefined}
          onClose={() => setDialogOpen(false)}
          onSave={editing ? handleSave : handleCreateAndMesh}
        />
      )}
    </div>
  )
}

// ── Materials ─────────────────────────────────────────────────────────────────

interface MaterialFormState {
  name: string; young: string; poisson: string; density: string
}

function MaterialSection() {
  const materials = useModelStore(s => s.materials)
  const createMaterial = useModelStore(s => s.createMaterial)
  const updateMaterial = useModelStore(s => s.updateMaterial)
  const deleteMaterial = useModelStore(s => s.deleteMaterial)

  const [editingId, setEditingId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<MaterialFormState>({ name: '', young: '210e9', poisson: '0.3', density: '7850' })

  function openNew() {
    setForm({ name: 'Material', young: '210e9', poisson: '0.3', density: '7850' })
    setEditingId('new')
  }

  function openEdit(m: Material) {
    setForm({ name: m.name, young: String(m.young), poisson: String(m.poisson), density: String(m.density) })
    setEditingId(m.id)
  }

  function save() {
    const mat = {
      name: form.name || 'Material',
      young: parseFloat(form.young) || 210e9,
      poisson: parseFloat(form.poisson) || 0.3,
      density: parseFloat(form.density) || 7850,
    }
    if (editingId === 'new') {
      createMaterial(mat)
    } else if (editingId !== null) {
      updateMaterial(editingId, mat)
    }
    setEditingId(null)
  }

  function field(key: keyof MaterialFormState, label: string, step = '1e8') {
    return (
      <div className={styles.inlineFormRow}>
        <span className={styles.inlineFormLabel}>{label}</span>
        <input
          className={styles.inlineFormInput}
          type="number"
          value={form[key]}
          step={step}
          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        />
      </div>
    )
  }

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span>Materials</span>
        <button className={styles.addBtn} onClick={openNew} title="Add material">+</button>
      </div>

      {materials.length === 0 && <div className={styles.empty}>None</div>}

      {materials.map(m => (
        <div key={m.id}>
          <div className={styles.item}>
            <div>
              <div className={styles.itemName}>{m.name}</div>
              <div className={styles.itemDetail}>E={fmt(m.young, 3)} Pa · ν={m.poisson}</div>
            </div>
            <div className={styles.itemActions}>
              <button className={styles.iconBtn} title="Edit" onClick={() => openEdit(m)}>✎</button>
              <button
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                title="Delete"
                onClick={() => deleteMaterial(m.id)}
              >×</button>
            </div>
          </div>
          {editingId === m.id && (
            <div className={styles.inlineForm}>
              <div className={styles.inlineFormRow}>
                <span className={styles.inlineFormLabel}>Name</span>
                <input
                  className={styles.inlineFormInput}
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>
              {field('young', 'E (Pa)', '1e9')}
              {field('poisson', 'ν', '0.01')}
              {field('density', 'ρ (kg/m³)', '100')}
              <div className={styles.inlineFormBtns}>
                <button className={styles.cancelBtn} onClick={() => setEditingId(null)}>Cancel</button>
                <button className={styles.saveBtn} onClick={save}>Save</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {editingId === 'new' && (
        <div className={styles.inlineForm}>
          <div className={styles.inlineFormRow}>
            <span className={styles.inlineFormLabel}>Name</span>
            <input
              className={styles.inlineFormInput}
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            />
          </div>
          {field('young', 'E (Pa)', '1e9')}
          {field('poisson', 'ν', '0.01')}
          {field('density', 'ρ (kg/m³)', '100')}
          <div className={styles.inlineFormBtns}>
            <button className={styles.cancelBtn} onClick={() => setEditingId(null)}>Cancel</button>
            <button className={styles.saveBtn} onClick={save}>Save</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Boundary Conditions ───────────────────────────────────────────────────────

function BcSection() {
  const constraints = useModelStore(s => s.constraints)
  const pickMode = useModelStore(s => s.pickMode)
  const setPickMode = useModelStore(s => s.setPickMode)
  const clearConstraints = useModelStore(s => s.clearConstraints)
  const bcGroups = groupConstraints(constraints)

  const isActive = pickMode === 'bc'

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span>Boundary Conditions</span>
      </div>
      <button
        className={`${styles.pickBtn} ${isActive ? styles.pickBtnActive : ''}`}
        onClick={() => setPickMode(isActive ? null : 'bc')}
      >
        {isActive ? '✕ Cancel selection' : '▣ Select face to fix…'}
      </button>
      {bcGroups.length === 0 && !isActive && (
        <div className={styles.empty}>None applied</div>
      )}
      {bcGroups.map(g => (
        <div key={`${g.dofLabel}=${g.value}`} className={styles.item}>
          <span className={styles.bcIcon}>▣</span>
          <div>
            <div className={styles.itemName}>{g.dofLabel} = {g.value}</div>
            <div className={styles.itemDetail}>{g.nodeCount} node{g.nodeCount !== 1 ? 's' : ''}</div>
          </div>
        </div>
      ))}
      {constraints.length > 0 && (
        <button className={styles.pickBtn} style={{ color: '#ff7070', borderColor: '#ff7070' }} onClick={clearConstraints}>
          ✕ Clear all BCs
        </button>
      )}
    </div>
  )
}

// ── Loads ─────────────────────────────────────────────────────────────────────

function LoadSection() {
  const loads = useModelStore(s => s.loads)
  const pickMode = useModelStore(s => s.pickMode)
  const setPickMode = useModelStore(s => s.setPickMode)
  const clearLoads = useModelStore(s => s.clearLoads)
  const loadGroups = groupLoads(loads)

  const isActive = pickMode === 'load'

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span>Loads</span>
      </div>
      <button
        className={`${styles.pickBtn} ${isActive ? styles.pickBtnActive : ''}`}
        onClick={() => setPickMode(isActive ? null : 'load')}
      >
        {isActive ? '✕ Cancel selection' : '↗ Select face to load…'}
      </button>
      {loadGroups.length === 0 && !isActive && (
        <div className={styles.empty}>None applied</div>
      )}
      {loadGroups.map(g => (
        <div key={g.dofLabel} className={styles.item}>
          <span className={styles.loadIcon}>↗</span>
          <div>
            <div className={styles.itemName}>F{g.dofLabel} = {fmt(g.total)} N</div>
            <div className={styles.itemDetail}>{g.nodeCount} node{g.nodeCount !== 1 ? 's' : ''}</div>
          </div>
        </div>
      ))}
      {loads.length > 0 && (
        <button className={styles.pickBtn} style={{ color: '#ff7070', borderColor: '#ff7070' }} onClick={clearLoads}>
          ✕ Clear all loads
        </button>
      )}
    </div>
  )
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

export function Sidebar() {
  return (
    <div className={styles.sidebar}>
      <GeometrySection />
      <MaterialSection />
      <BcSection />
      <LoadSection />
    </div>
  )
}

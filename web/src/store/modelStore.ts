import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { meshFromBox, geomToBoxParams } from '../lib/meshFromBox'

export interface Node {
  id: number
  x: number
  y: number
  z: number
}

export type ElementType =
  | 'CBAR' | 'CBEAM'
  | 'CTRIA3' | 'CTRIA6' | 'CQUAD4' | 'CQUAD8'
  | 'CTETRA' | 'CPENTA' | 'CHEXA' | 'CPYRAM'

export type PropertyType = 'PBAR' | 'PBEAM' | 'PSHELL' | 'PLPLANE' | 'PSOLID'

export interface Property {
  id: number
  type: PropertyType
  materialId: number
  thickness?: number
  planeFormulation?: 'PlaneStress' | 'PlaneStrain'
  area?: number
  i1?: number
  i2?: number
  j?: number
}

export interface Element {
  id: number
  type: ElementType
  nodeIds: number[]
  propertyId: number
}

export interface Material {
  id: number
  name: string
  young: number
  poisson: number
  density: number
}

export interface Constraint {
  nodeId: number
  dof: number       // 0=Ux 1=Uy 2=Uz 3=Rx 4=Ry 5=Rz
  prescribedValue?: number
}

export interface Load {
  nodeId: number
  dof: number
  value: number
}

export interface SolverResult {
  displacements: Float64Array
  vonMises?: Float64Array
}

export interface StepSurfaceMesh {
  points: [number, number, number][]
  triangles: [number, number, number][]
}

export interface VolMesh {
  points: [number, number, number][]
  edges: [number, number][]
}

// ── Geometry ──────────────────────────────────────────────────────────────────

export interface BoxGeometry {
  id: number
  name: string
  ox: number; oy: number; oz: number   // origin
  sketchWidth: number                   // first dimension in sketch plane
  sketchHeight: number                  // second dimension in sketch plane
  sketchNormal: 'X' | 'Y' | 'Z'        // normal to sketch plane = extrude axis
  extrudeSign: 1 | -1                   // +1 or -1 along the normal
  extrudeLength: number
  meshNu: number; meshNv: number; meshNw: number
}

export interface FaceSelection {
  nodeIds: number[]
  label: string    // e.g. "Min X face (9 nodes)"
  axis: 'X' | 'Y' | 'Z'
  isMax: boolean
}

// ── Default model ─────────────────────────────────────────────────────────────

const DEFAULT_GEOMETRY: BoxGeometry = {
  id: 1,
  name: 'Cantilever Beam',
  ox: 0, oy: 0, oz: 0,
  sketchNormal: 'X',
  sketchWidth: 0.1,
  sketchHeight: 0.1,
  extrudeSign: 1,
  extrudeLength: 1.0,
  meshNu: 2, meshNv: 2, meshNw: 10,
}

function buildCantilever() {
  const nx = 10, ny = 2, nz = 2
  const L = 1.0, h = 0.1
  const dx = L / nx, dy = h / ny, dz = h / nz

  const strideZ = nz + 1
  const strideX = (ny + 1) * (nz + 1)
  const nid = (ix: number, iy: number, iz: number) => ix * strideX + iy * strideZ + iz

  const nodes: Node[] = []
  for (let ix = 0; ix <= nx; ix++)
    for (let iy = 0; iy <= ny; iy++)
      for (let iz = 0; iz <= nz; iz++)
        nodes.push({ id: nid(ix, iy, iz), x: ix * dx, y: iy * dy, z: iz * dz })

  const elements: Element[] = []
  let eid = 0
  for (let ei = 0; ei < nx; ei++)
    for (let ej = 0; ej < ny; ej++)
      for (let ek = 0; ek < nz; ek++)
        elements.push({
          id: eid++,
          type: 'CHEXA',
          nodeIds: [
            nid(ei,   ej,   ek),   nid(ei+1, ej,   ek),
            nid(ei+1, ej+1, ek),   nid(ei,   ej+1, ek),
            nid(ei,   ej,   ek+1), nid(ei+1, ej,   ek+1),
            nid(ei+1, ej+1, ek+1), nid(ei,   ej+1, ek+1),
          ],
          propertyId: 1,
        })

  const materials: Material[] = [
    { id: 1, name: 'Steel', young: 210e9, poisson: 0.3, density: 7850 },
  ]
  const properties: Property[] = [
    { id: 1, type: 'PSOLID', materialId: 1 },
  ]

  const constraints: Constraint[] = []
  for (let iy = 0; iy <= ny; iy++)
    for (let iz = 0; iz <= nz; iz++)
      for (const dof of [0, 1, 2])
        constraints.push({ nodeId: nid(0, iy, iz), dof, prescribedValue: 0 })

  const nFace = (ny + 1) * (nz + 1)
  const fNode = -10_000 / nFace
  const loads: Load[] = []
  for (let iy = 0; iy <= ny; iy++)
    for (let iz = 0; iz <= nz; iz++)
      loads.push({ nodeId: nid(nx, iy, iz), dof: 1, value: fNode })

  return { nodes, elements, materials, properties, constraints, loads }
}

// ── Store types ───────────────────────────────────────────────────────────────

export interface ModelSnapshot {
  nodes: Node[]
  elements: Element[]
  materials: Material[]
  properties: Property[]
  constraints: Constraint[]
  loads: Load[]
}

export interface StartCustomParams {
  name: string
  lx: number; ly: number; lz: number
  nx: number; ny: number; nz: number
}

export type AppMode = 'geometry' | 'mesh' | 'constraints' | 'solve' | 'results'

interface ModelState extends ModelSnapshot {
  modelName: string
  hasStarted: boolean
  mode: AppMode
  result: SolverResult | null
  stepSurface: StepSurfaceMesh | null
  isRunning: boolean
  isMeshing: boolean
  geometries: BoxGeometry[]
  nextGeomId: number
  nextMatId: number
  pickMode: 'bc' | 'load' | null
  selectedFace: FaceSelection | null

  volMesh: VolMesh | null
  viewRepr: 'geometry' | 'surface' | 'volume' | 'wireframe'
  stepImportError: string | null
  setStepSurface(mesh: StepSurfaceMesh | null): void
  setVolMesh(mesh: VolMesh | null): void
  setViewRepr(v: 'geometry' | 'surface' | 'volume' | 'wireframe'): void
  setStepImportError(msg: string | null): void

  // Welcome screen entry points
  startWithExample(): void
  startCustom(params: StartCustomParams): void

  // Mode navigation
  setMode(mode: AppMode): void

  // Solver
  addNode(node: Node): void
  addElement(el: Element): void
  addMaterial(mat: Material): void
  addProperty(prop: Property): void
  setResult(result: SolverResult): void
  setRunning(v: boolean): void
  setMeshing(v: boolean): void
  applyMeshResult(nodes: Node[], elements: Element[], modelName: string): void
  loadModel(snapshot: ModelSnapshot & { modelName?: string }): void
  reset(): void

  // Geometry CRUD
  addGeometry(g: Omit<BoxGeometry, 'id'>): void
  updateGeometry(id: number, patch: Partial<Omit<BoxGeometry, 'id'>>): void
  deleteGeometry(id: number): void
  meshGeometry(id: number): void

  // Material CRUD
  createMaterial(mat: Omit<Material, 'id'>): void
  updateMaterial(id: number, patch: Partial<Omit<Material, 'id'>>): void
  deleteMaterial(id: number): void

  // BC / Load via face selection
  setPickMode(mode: 'bc' | 'load' | null): void
  setSelectedFace(face: FaceSelection | null): void
  applyBcToFace(nodeIds: number[], dofs: number[], value: number): void
  applyLoadToFace(nodeIds: number[], dof: number, totalForce: number): void
  clearConstraints(): void
  clearLoads(): void

  // Viewport
  fitViewTrigger: number
  triggerFitView(): void
}

// ── Store ─────────────────────────────────────────────────────────────────────

const EMPTY_MODEL = {
  nodes: [] as Node[],
  elements: [] as Element[],
  materials: [{ id: 1, name: 'Steel', young: 210e9, poisson: 0.3, density: 7850 }] as Material[],
  properties: [{ id: 1, type: 'PSOLID' as const, materialId: 1 }] as Property[],
  constraints: [] as Constraint[],
  loads: [] as Load[],
}

export const useModelStore = create<ModelState>()(
  immer((set) => ({
    ...EMPTY_MODEL,
    modelName: '',
    hasStarted: false,
    mode: 'geometry' as AppMode,
    result: null,
    stepSurface: null,
    isRunning: false,
    isMeshing: false,
    volMesh: null,
    viewRepr: 'surface' as const,
    stepImportError: null,
    geometries: [],
    nextGeomId: 2,
    nextMatId: 2,
    pickMode: null,
    selectedFace: null,
    fitViewTrigger: 0,

    setStepImportError: (msg) => set(s => { s.stepImportError = msg }),
    setViewRepr: (v) => set(s => { s.viewRepr = v }),
    setVolMesh: (mesh) => set(s => { s.volMesh = mesh; if (mesh) s.viewRepr = 'volume' }),
    setStepSurface: (mesh) => set(s => {
      s.stepSurface = mesh
      s.volMesh = null; s.viewRepr = 'geometry'
      s.stepImportError = null
      s.nodes = []; s.elements = []
      s.constraints = []; s.loads = []
      s.result = null
      if (mesh) { s.fitViewTrigger++; s.hasStarted = true; s.mode = 'geometry' }
    }),
    triggerFitView: () => set(s => { s.fitViewTrigger++ }),

    setMode: (mode) => set(s => { s.mode = mode }),

    startWithExample: () => set(s => {
      const c = buildCantilever()
      s.nodes = c.nodes; s.elements = c.elements
      s.materials = c.materials; s.properties = c.properties
      s.constraints = c.constraints; s.loads = c.loads
      s.modelName = 'Cantilever Beam'
      s.geometries = [DEFAULT_GEOMETRY]
      s.result = null; s.stepSurface = null; s.volMesh = null
      s.viewRepr = 'surface'; s.selectedFace = null; s.pickMode = null
      s.hasStarted = true; s.mode = 'geometry'
      s.fitViewTrigger++
    }),

    startCustom: ({ name, lx, ly, lz, nx, ny, nz }) => set(s => {
      const { nodes, elements } = meshFromBox({ ox: 0, oy: 0, oz: 0, lx, ly, lz, nx, ny, nz })
      s.nodes = nodes; s.elements = elements
      s.materials = [{ id: 1, name: 'Steel', young: 210e9, poisson: 0.3, density: 7850 }]
      s.properties = [{ id: 1, type: 'PSOLID', materialId: 1 }]
      s.constraints = []; s.loads = []
      s.modelName = name || 'Model'
      s.geometries = [{
        id: 1, name: name || 'Model',
        ox: 0, oy: 0, oz: 0,
        sketchNormal: 'X', sketchWidth: ly, sketchHeight: lz,
        extrudeSign: 1, extrudeLength: lx,
        meshNu: ny, meshNv: nz, meshNw: nx,
      }]
      s.nextGeomId = 2
      s.result = null; s.stepSurface = null; s.volMesh = null
      s.viewRepr = 'surface'; s.selectedFace = null; s.pickMode = null
      s.hasStarted = true; s.mode = 'geometry'
      s.fitViewTrigger++
    }),

    addNode: (node) => set(s => { s.nodes.push(node) }),
    addElement: (el) => set(s => { s.elements.push(el) }),
    addMaterial: (mat) => set(s => { s.materials.push(mat) }),
    addProperty: (prop) => set(s => { s.properties.push(prop) }),
    setResult: (result) => set(s => { s.result = result }),
    setRunning: (v) => set(s => { s.isRunning = v }),
    setMeshing: (v) => set(s => { s.isMeshing = v }),

    applyMeshResult: (nodes, elements, name) => set(s => {
      s.nodes = nodes
      s.elements = elements
      s.constraints = []
      s.loads = []
      s.result = null
      s.selectedFace = null
      s.pickMode = null
      s.modelName = name
      s.viewRepr = 'surface'
      s.fitViewTrigger++
      if (!s.properties.find(p => p.type === 'PSOLID')) {
        const matId = s.materials[0]?.id ?? 1
        s.properties = [{ id: 1, type: 'PSOLID', materialId: matId }]
      }
    }),

    loadModel: (snap) => set(s => {
      s.nodes = snap.nodes
      s.elements = snap.elements
      s.materials = snap.materials
      s.properties = snap.properties
      s.constraints = snap.constraints
      s.loads = snap.loads
      s.modelName = snap.modelName ?? 'Model'
      s.result = null
      s.geometries = []
      s.selectedFace = null
      s.pickMode = null
      s.hasStarted = true
      s.mode = 'geometry'
      s.fitViewTrigger++
    }),

    reset: () => set(s => {
      s.nodes = []; s.elements = []
      s.materials = [{ id: 1, name: 'Steel', young: 210e9, poisson: 0.3, density: 7850 }]
      s.properties = [{ id: 1, type: 'PSOLID', materialId: 1 }]
      s.constraints = []; s.loads = []
      s.modelName = ''
      s.result = null
      s.stepSurface = null
      s.volMesh = null
      s.viewRepr = 'surface'
      s.geometries = []
      s.nextGeomId = 2
      s.nextMatId = 2
      s.selectedFace = null
      s.pickMode = null
      s.hasStarted = false
    }),

    // Geometry CRUD
    addGeometry: (g) => set(s => {
      s.geometries.push({ ...g, id: s.nextGeomId++ })
    }),

    updateGeometry: (id, patch) => set(s => {
      const idx = s.geometries.findIndex(g => g.id === id)
      if (idx >= 0) Object.assign(s.geometries[idx], patch)
    }),

    deleteGeometry: (id) => set(s => {
      s.geometries = s.geometries.filter(g => g.id !== id)
    }),

    meshGeometry: (id) => set(s => {
      const geom = s.geometries.find(g => g.id === id)
      if (!geom) return
      const params = geomToBoxParams(geom)
      const { nodes, elements } = meshFromBox(params)
      s.nodes = nodes
      s.elements = elements
      s.constraints = []
      s.loads = []
      s.result = null
      s.selectedFace = null
      s.pickMode = null
      s.modelName = geom.name
      // Ensure PSOLID property with material 1 exists
      if (!s.properties.find(p => p.type === 'PSOLID')) {
        const matId = s.materials[0]?.id ?? 1
        s.properties = [{ id: 1, type: 'PSOLID', materialId: matId }]
      }
    }),

    // Material CRUD
    createMaterial: (mat) => set(s => {
      s.materials.push({ ...mat, id: s.nextMatId++ })
    }),

    updateMaterial: (id, patch) => set(s => {
      const idx = s.materials.findIndex(m => m.id === id)
      if (idx >= 0) Object.assign(s.materials[idx], patch)
    }),

    deleteMaterial: (id) => set(s => {
      s.materials = s.materials.filter(m => m.id !== id)
    }),

    // Pick mode / face selection
    setPickMode: (mode) => set(s => {
      s.pickMode = mode
      if (mode === null) s.selectedFace = null
    }),

    setSelectedFace: (face) => set(s => { s.selectedFace = face }),

    applyBcToFace: (nodeIds, dofs, value) => set(s => {
      // Remove existing constraints on those nodes+dofs first
      s.constraints = s.constraints.filter(
        c => !(nodeIds.includes(c.nodeId) && dofs.includes(c.dof)),
      )
      for (const nodeId of nodeIds)
        for (const dof of dofs)
          s.constraints.push({ nodeId, dof, prescribedValue: value })
      s.result = null
    }),

    applyLoadToFace: (nodeIds, dof, totalForce) => set(s => {
      // Remove existing loads on those nodes+dof
      s.loads = s.loads.filter(l => !(nodeIds.includes(l.nodeId) && l.dof === dof))
      const perNode = totalForce / nodeIds.length
      for (const nodeId of nodeIds)
        s.loads.push({ nodeId, dof, value: perNode })
      s.result = null
    }),

    clearConstraints: () => set(s => { s.constraints = []; s.result = null }),
    clearLoads: () => set(s => { s.loads = []; s.result = null }),
  }))
)

// Expose store on window so Playwright tests can inject BCs/loads
// without requiring 3D face-picking interactions.
;(window as Window & { __kofemStore?: typeof useModelStore }).__kofemStore = useModelStore

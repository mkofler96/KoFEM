import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

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

// 10×2×2 CHEXA8 cantilever: 40 elements, 99 nodes
// Steel 100mm × 100mm cross-section, L=1m
// Fixed left face, Fy = -10 kN at right face
function buildCantilever() {
  const nx = 10, ny = 2, nz = 2
  const L = 1.0, h = 0.1   // beam length, cross-section side (m)
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

  // Fix Ux, Uy, Uz at left face (ix=0)
  const constraints: Constraint[] = []
  for (let iy = 0; iy <= ny; iy++)
    for (let iz = 0; iz <= nz; iz++)
      for (const dof of [0, 1, 2])
        constraints.push({ nodeId: nid(0, iy, iz), dof, prescribedValue: 0 })

  // Distribute P = -10 kN equally over (ny+1)*(nz+1) = 9 right-face nodes
  const nFace = (ny + 1) * (nz + 1)
  const fNode = -10_000 / nFace
  const loads: Load[] = []
  for (let iy = 0; iy <= ny; iy++)
    for (let iz = 0; iz <= nz; iz++)
      loads.push({ nodeId: nid(nx, iy, iz), dof: 1, value: fNode })

  return { nodes, elements, materials, properties, constraints, loads }
}

const cantilever = buildCantilever()

interface ModelState {
  nodes: Node[]
  elements: Element[]
  materials: Material[]
  properties: Property[]
  constraints: Constraint[]
  loads: Load[]
  result: SolverResult | null
  isRunning: boolean

  addNode: (node: Node) => void
  addElement: (el: Element) => void
  addMaterial: (mat: Material) => void
  addProperty: (prop: Property) => void
  setResult: (result: SolverResult) => void
  setRunning: (v: boolean) => void
  reset: () => void
}

export const useModelStore = create<ModelState>()(
  immer((set) => ({
    ...cantilever,
    result: null,
    isRunning: false,

    addNode: (node) => set(s => { s.nodes.push(node) }),
    addElement: (el) => set(s => { s.elements.push(el) }),
    addMaterial: (mat) => set(s => { s.materials.push(mat) }),
    addProperty: (prop) => set(s => { s.properties.push(prop) }),
    setResult: (result) => set(s => { s.result = result }),
    setRunning: (v) => set(s => { s.isRunning = v }),
    reset: () => set(s => {
      Object.assign(s, buildCantilever())
      s.result = null
    }),
  }))
)

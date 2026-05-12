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

// 10-element cantilever: nodes 0..10 at x = 0,0.1,...,1.0 m
// Steel square section 10mm × 10mm
// Fixed at node 0, Fy = -1 N at node 10
function buildCantilever() {
  const N = 11
  const L = 1.0
  const nodes: Node[] = Array.from({ length: N }, (_, i) => ({
    id: i,
    x: (i * L) / (N - 1),
    y: 0,
    z: 0,
  }))

  const elements: Element[] = Array.from({ length: N - 1 }, (_, i) => ({
    id: i,
    type: 'CBAR' as ElementType,
    nodeIds: [i, i + 1],
    propertyId: 1,
  }))

  const materials: Material[] = [
    { id: 1, name: 'Steel', young: 210e9, poisson: 0.3, density: 7850 },
  ]

  // 10 mm × 10 mm square section
  const a = 0.01
  const area = a * a                    // 1e-4 m²
  const i1 = (a ** 4) / 12             // 8.333e-10 m⁴
  const i2 = i1
  const j = 0.1406 * a ** 4            // torsional constant for square

  const properties: Property[] = [
    { id: 1, type: 'PBAR', materialId: 1, area, i1, i2, j },
  ]

  // Fix all 6 DOF at node 0
  const constraints: Constraint[] = [0, 1, 2, 3, 4, 5].map(dof => ({
    nodeId: 0,
    dof,
    prescribedValue: 0,
  }))

  // Apply Fy = -1 N at tip (node 10)
  const loads: Load[] = [{ nodeId: N - 1, dof: 1, value: -1 }]

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

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export interface Node {
  id: number
  x: number
  y: number
  z: number
}

// Nastran element type names
export type ElementType =
  // Line elements
  | 'CBAR' | 'CBEAM'
  // Surface elements (shell: PSHELL, or 2D plane: PLPLANE — set by property)
  | 'CTRIA3' | 'CTRIA6' | 'CQUAD4' | 'CQUAD8'
  // Solid elements
  | 'CTETRA' | 'CPENTA' | 'CHEXA' | 'CPYRAM'

// Nastran property card types
export type PropertyType = 'PBAR' | 'PBEAM' | 'PSHELL' | 'PLPLANE' | 'PSOLID'

export interface Property {
  id: number
  type: PropertyType
  materialId: number
  // PSHELL / PLPLANE
  thickness?: number
  // PLPLANE
  planeFormulation?: 'PlaneStress' | 'PlaneStrain'
  // PBAR / PBEAM
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

export interface SolverResult {
  displacements: Float64Array
  vonMises?: Float64Array
}

interface ModelState {
  nodes: Node[]
  elements: Element[]
  materials: Material[]
  properties: Property[]
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
    nodes: [],
    elements: [],
    materials: [{ id: 1, name: 'Steel', young: 210e9, poisson: 0.3, density: 7850 }],
    properties: [
      { id: 1, type: 'PSHELL', materialId: 1, thickness: 0.01 },
      { id: 2, type: 'PSOLID', materialId: 1 },
      { id: 3, type: 'PLPLANE', materialId: 1, thickness: 0.01, planeFormulation: 'PlaneStress' },
    ],
    result: null,
    isRunning: false,

    addNode: (node) => set(s => { s.nodes.push(node) }),
    addElement: (el) => set(s => { s.elements.push(el) }),
    addMaterial: (mat) => set(s => { s.materials.push(mat) }),
    addProperty: (prop) => set(s => { s.properties.push(prop) }),
    setResult: (result) => set(s => { s.result = result }),
    setRunning: (v) => set(s => { s.isRunning = v }),
    reset: () => set(s => { s.nodes = []; s.elements = []; s.result = null }),
  }))
)

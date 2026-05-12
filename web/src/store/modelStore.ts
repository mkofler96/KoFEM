import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'

export interface Node {
  id: number
  x: number
  y: number
  z: number
}

export interface Element {
  id: number
  type: 'Beam2' | 'Shell4' | 'Shell8' | 'Tet4' | 'Hex8'
  nodeIds: number[]
  materialId: number
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
  result: SolverResult | null
  isRunning: boolean

  addNode: (node: Node) => void
  addElement: (el: Element) => void
  addMaterial: (mat: Material) => void
  setResult: (result: SolverResult) => void
  setRunning: (v: boolean) => void
  reset: () => void
}

export const useModelStore = create<ModelState>()(
  immer((set) => ({
    nodes: [],
    elements: [],
    materials: [{ id: 1, name: 'Steel', young: 210e9, poisson: 0.3, density: 7850 }],
    result: null,
    isRunning: false,

    addNode: (node) => set(s => { s.nodes.push(node) }),
    addElement: (el) => set(s => { s.elements.push(el) }),
    addMaterial: (mat) => set(s => { s.materials.push(mat) }),
    setResult: (result) => set(s => { s.result = result }),
    setRunning: (v) => set(s => { s.isRunning = v }),
    reset: () => set(s => { s.nodes = []; s.elements = []; s.result = null }),
  }))
)

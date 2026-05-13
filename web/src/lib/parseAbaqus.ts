// Display helpers for the ModelTree and PropertiesPanel.
// Actual INP parsing is handled by the Rust/WASM parse_inp_model function.

import type { Constraint, Load } from '../store/modelStore'

export const DOF_LABEL = ['Ux', 'Uy', 'Uz', 'Rx', 'Ry', 'Rz']

export interface BcGroup {
  dofLabel: string
  value: number
  nodeCount: number
}

export interface LoadGroup {
  dofLabel: string
  total: number
  nodeCount: number
}

export function groupConstraints(constraints: Constraint[]): BcGroup[] {
  const nodeMap = new Map<number, Map<number, number>>()
  for (const c of constraints) {
    if (!nodeMap.has(c.nodeId)) nodeMap.set(c.nodeId, new Map())
    nodeMap.get(c.nodeId)!.set(c.dof, c.prescribedValue ?? 0)
  }
  const groups = new Map<string, number>()
  for (const dofMap of nodeMap.values()) {
    const sorted = [...dofMap.entries()].sort((a, b) => a[0] - b[0])
    const key = sorted.map(([d, v]) => `${d}=${v}`).join(',')
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  return [...groups.entries()].map(([key, nodeCount]) => {
    const pairs = key.split(',').map(kv => {
      const [d, v] = kv.split('=')
      return { dof: Number(d), value: Number(v) }
    })
    return {
      dofLabel: pairs.map(p => DOF_LABEL[p.dof]).join(', '),
      value: pairs[0]?.value ?? 0,
      nodeCount,
    }
  })
}

export function groupLoads(loads: Load[]): LoadGroup[] {
  const groups = new Map<number, { total: number; nodes: Set<number> }>()
  for (const l of loads) {
    if (!groups.has(l.dof)) groups.set(l.dof, { total: 0, nodes: new Set() })
    const g = groups.get(l.dof)!
    g.total += l.value
    g.nodes.add(l.nodeId)
  }
  return [...groups.entries()].map(([dof, g]) => ({
    dofLabel: DOF_LABEL[dof],
    total: g.total,
    nodeCount: g.nodes.size,
  }))
}

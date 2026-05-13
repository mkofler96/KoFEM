import type { Node, Element, ElementType, Material, Property, PropertyType, Constraint, Load } from '../store/modelStore'

export interface ParsedModel {
  nodes: Node[]
  elements: Element[]
  materials: Material[]
  properties: Property[]
  constraints: Constraint[]
  loads: Load[]
  modelName: string
}

type PropHint = 'solid' | 'plane_stress' | 'plane_strain' | 'shell' | 'beam'

interface SectionDef {
  elset: string
  matName: string
  propHint: PropHint
  thickness?: number
}

const DOF_NAMES = ['Ux', 'Uy', 'Uz', 'Rx', 'Ry', 'Rz']

// Maps Abaqus element type strings to KoFEM types
function mapAbaqusElement(t: string): { kofemType: ElementType; propHint: PropHint } | null {
  const u = t.toUpperCase().replace(/\s+/g, '')
  if (/^C3D4H?$/.test(u))                     return { kofemType: 'CTETRA', propHint: 'solid' }
  if (/^C3D10[HM]?$/.test(u))                 return { kofemType: 'CTETRA', propHint: 'solid' }
  if (/^C3D8[RIH]?$/.test(u))                 return { kofemType: 'CHEXA',  propHint: 'solid' }
  if (/^C3D20[RH]?$/.test(u))                 return { kofemType: 'CHEXA',  propHint: 'solid' }
  if (/^C3D6H?$/.test(u))                     return { kofemType: 'CPENTA', propHint: 'solid' }
  if (u === 'C3D5')                            return { kofemType: 'CPYRAM', propHint: 'solid' }
  if (/^CPS[36]$/.test(u))                    return { kofemType: 'CTRIA3', propHint: 'plane_stress' }
  if (/^CPE[36]H?$/.test(u))                  return { kofemType: 'CTRIA3', propHint: 'plane_strain' }
  if (/^CPS4R?$/.test(u))                     return { kofemType: 'CQUAD4', propHint: 'plane_stress' }
  if (/^CPE4[RH]?$/.test(u))                  return { kofemType: 'CQUAD4', propHint: 'plane_strain' }
  if (/^S3R?$|^STRI3$/.test(u))               return { kofemType: 'CTRIA3', propHint: 'shell' }
  if (/^S4R?[5]?$/.test(u))                   return { kofemType: 'CQUAD4', propHint: 'shell' }
  if (/^B3[123]R?$/.test(u))                  return { kofemType: 'CBAR',   propHint: 'beam' }
  return null
}

function parseKeyword(line: string): { kw: string; params: Record<string, string> } {
  const parts = line.slice(1).split(',')
  const kw = parts[0].trim().toUpperCase()
  const params: Record<string, string> = {}
  for (let i = 1; i < parts.length; i++) {
    const [k, v] = parts[i].split('=')
    if (k) params[k.trim().toUpperCase()] = (v ?? '').trim()
  }
  return { kw, params }
}

// Expand Abaqus DOF shorthand types to arrays of 0-based KoFEM DOF indices
function builtinDofs(type: string): number[] | null {
  switch (type.toUpperCase()) {
    case 'ENCASTRE': return [0, 1, 2, 3, 4, 5]
    case 'PINNED':   return [0, 1, 2]
    case 'XSYMM':   return [0, 4, 5]  // fix Ux, Ry, Rz
    case 'YSYMM':   return [1, 3, 5]  // fix Uy, Rx, Rz
    case 'ZSYMM':   return [2, 3, 4]  // fix Uz, Rx, Ry
    default:         return null
  }
}

function resolveNodeSet(
  token: string,
  nodeSets: Map<string, number[]>,
): number[] {
  const num = parseInt(token)
  if (!isNaN(num)) return [num]
  return nodeSets.get(token.toUpperCase()) ?? []
}

export function parseAbaqus(inp: string): ParsedModel {
  const lines = inp.split(/\r?\n/)

  const nodes: Node[] = []
  const elements: Element[] = []
  const materials: Material[] = []
  const properties: Property[] = []
  const constraints: Constraint[] = []
  const loads: Load[] = []

  // Named sets
  const nodeSets = new Map<string, number[]>()
  const elemSets = new Map<string, number[]>()

  // Per-element type hint: elemId → propHint (from *ELEMENT TYPE= param)
  const elemHints = new Map<number, PropHint>()

  // Material defs accumulated from *MATERIAL + *ELASTIC + *DENSITY
  interface MatDef { name: string; young: number; poisson: number; density: number }
  const matDefs = new Map<string, MatDef>() // uppercase name → def

  const sectionDefs: SectionDef[] = []

  let modelName = 'Abaqus Model'
  let kw = ''
  let params: Record<string, string> = {}
  let currentMat = ''
  let pendingSection: SectionDef | null = null
  let sectionDataRead = false

  let i = 0
  while (i < lines.length) {
    const raw = lines[i++]
    const line = raw.trim()

    if (line === '' || line.startsWith('**')) continue

    // ── Keyword line ────────────────────────────────────────────────────────────
    if (line.startsWith('*')) {
      // Flush any pending section from previous keyword
      if (pendingSection && !sectionDataRead) {
        sectionDefs.push(pendingSection)
        pendingSection = null
      }

      const parsed = parseKeyword(line)
      kw = parsed.kw
      params = parsed.params
      pendingSection = null
      sectionDataRead = false

      if (kw === 'HEADING') {
        if (i < lines.length && !lines[i].trimStart().startsWith('*')) {
          modelName = lines[i].trim() || modelName
          i++
        }
      } else if (kw === 'MATERIAL') {
        currentMat = (params['NAME'] || 'Material').toUpperCase()
        if (!matDefs.has(currentMat)) {
          matDefs.set(currentMat, { name: params['NAME'] || 'Material', young: 0, poisson: 0, density: 0 })
        }
      } else if (kw === 'SOLID SECTION' || kw === 'MEMBRANE SECTION') {
        pendingSection = {
          elset: (params['ELSET'] || '').toUpperCase(),
          matName: (params['MATERIAL'] || '').toUpperCase(),
          propHint: 'solid',
        }
      } else if (kw === 'SHELL SECTION') {
        pendingSection = {
          elset: (params['ELSET'] || '').toUpperCase(),
          matName: (params['MATERIAL'] || '').toUpperCase(),
          propHint: 'shell',
        }
      } else if (kw === 'BEAM SECTION' || kw === 'BEAM GENERAL SECTION') {
        pendingSection = {
          elset: (params['ELSET'] || '').toUpperCase(),
          matName: (params['MATERIAL'] || '').toUpperCase(),
          propHint: 'beam',
        }
      }
      continue
    }

    // ── Data line ───────────────────────────────────────────────────────────────

    // Handle pending section: first data line may carry thickness
    if (pendingSection && !sectionDataRead) {
      sectionDataRead = true
      const thickness = parseFloat(line.split(',')[0])
      if (!isNaN(thickness) && thickness > 0) pendingSection.thickness = thickness
      sectionDefs.push(pendingSection)
      pendingSection = null
      continue
    }

    const parts = line.split(',').map(s => s.trim())

    if (kw === 'NODE') {
      if (parts.length >= 4) {
        const id = parseInt(parts[0])
        const x = parseFloat(parts[1])
        const y = parseFloat(parts[2])
        const z = parseFloat(parts[3])
        if (!isNaN(id)) nodes.push({ id, x: x || 0, y: y || 0, z: z || 0 })
      }

    } else if (kw === 'ELEMENT') {
      // Elements may span multiple lines (trailing comma = continuation)
      let dataLine = line
      while (dataLine.endsWith(',') && i < lines.length) {
        const next = lines[i].trim()
        if (next.startsWith('*') || next.startsWith('**')) break
        dataLine += next
        i++
      }
      const ps = dataLine.split(',').map(s => s.trim()).filter(Boolean)
      if (ps.length >= 2) {
        const mapped = mapAbaqusElement(params['TYPE'] || '')
        if (mapped) {
          const id = parseInt(ps[0])
          const nodeIds = ps.slice(1).map(Number).filter(n => !isNaN(n))
          elements.push({ id, type: mapped.kofemType, nodeIds, propertyId: 0 })
          elemHints.set(id, mapped.propHint)
          const elset = (params['ELSET'] || '').toUpperCase()
          if (elset) {
            if (!elemSets.has(elset)) elemSets.set(elset, [])
            elemSets.get(elset)!.push(id)
          }
        }
      }

    } else if (kw === 'NSET') {
      const name = (params['NSET'] || '').toUpperCase()
      if (!name) continue
      if (!nodeSets.has(name)) nodeSets.set(name, [])
      const set = nodeSets.get(name)!
      if ('GENERATE' in params) {
        const [s, e, st] = parts.map(Number)
        const step = isNaN(st) || st === 0 ? 1 : st
        for (let n = s; n <= e; n += step) set.push(n)
      } else {
        for (const p of parts) {
          const n = parseInt(p)
          if (!isNaN(n)) set.push(n)
          else {
            const ref = nodeSets.get(p.toUpperCase())
            if (ref) set.push(...ref)
          }
        }
      }

    } else if (kw === 'ELSET') {
      const name = (params['ELSET'] || '').toUpperCase()
      if (!name) continue
      if (!elemSets.has(name)) elemSets.set(name, [])
      const set = elemSets.get(name)!
      if ('GENERATE' in params) {
        const [s, e, st] = parts.map(Number)
        const step = isNaN(st) || st === 0 ? 1 : st
        for (let n = s; n <= e; n += step) set.push(n)
      } else {
        for (const p of parts) {
          const n = parseInt(p)
          if (!isNaN(n)) set.push(n)
        }
      }

    } else if (kw === 'ELASTIC' && currentMat) {
      const mat = matDefs.get(currentMat)!
      mat.young = parseFloat(parts[0]) || 0
      mat.poisson = parseFloat(parts[1]) || 0

    } else if (kw === 'DENSITY' && currentMat) {
      const mat = matDefs.get(currentMat)!
      mat.density = parseFloat(parts[0]) || 0

    } else if (kw === 'BOUNDARY') {
      const token = parts[0]
      const second = parts[1] || ''
      const builtIn = builtinDofs(second)

      if (builtIn) {
        // e.g. "Fixed, ENCASTRE"
        for (const nodeId of resolveNodeSet(token, nodeSets)) {
          for (const dof of builtIn) {
            constraints.push({ nodeId, dof, prescribedValue: 0 })
          }
        }
      } else {
        // "node-or-set, dof_start, dof_end[, value]"
        const dofStart = (parseInt(parts[1]) || 1) - 1  // 1-based → 0-based
        const dofEnd   = parts[2] ? (parseInt(parts[2]) || 1) - 1 : dofStart
        const value    = parts[3] ? parseFloat(parts[3]) : 0
        for (const nodeId of resolveNodeSet(token, nodeSets)) {
          for (let dof = dofStart; dof <= dofEnd; dof++) {
            if (dof >= 0 && dof <= 5) constraints.push({ nodeId, dof, prescribedValue: value })
          }
        }
      }

    } else if (kw === 'CLOAD') {
      const token = parts[0]
      const dof = (parseInt(parts[1]) || 1) - 1  // 1-based → 0-based
      const value = parseFloat(parts[2]) || 0
      for (const nodeId of resolveNodeSet(token, nodeSets)) {
        if (dof >= 0 && dof <= 5) loads.push({ nodeId, dof, value })
      }
    }
  }

  // Flush last pending section (no data line followed it)
  if (pendingSection) sectionDefs.push(pendingSection)

  // ── Materialise store objects ─────────────────────────────────────────────────
  let matIdCounter = 1
  const matNameToId = new Map<string, number>()
  for (const [upper, def] of matDefs) {
    const id = matIdCounter++
    materials.push({ id, name: def.name, young: def.young, poisson: def.poisson, density: def.density })
    matNameToId.set(upper, id)
  }

  let propIdCounter = 1
  const elsetToPropId = new Map<string, number>()

  for (const sec of sectionDefs) {
    const matId = matNameToId.get(sec.matName) || 1
    const propId = propIdCounter++
    elsetToPropId.set(sec.elset, propId)

    // Refine hint from actual element types in this elset
    let hint = sec.propHint
    for (const eid of elemSets.get(sec.elset) ?? []) {
      const h = elemHints.get(eid)
      if (h) { hint = h; break }
    }

    let type: PropertyType
    let planeFormulation: 'PlaneStress' | 'PlaneStrain' | undefined

    switch (hint) {
      case 'plane_stress': type = 'PLPLANE'; planeFormulation = 'PlaneStress'; break
      case 'plane_strain': type = 'PLPLANE'; planeFormulation = 'PlaneStrain'; break
      case 'shell':        type = 'PSHELL'; break
      case 'beam':         type = 'PBAR'; break
      default:             type = 'PSOLID'
    }

    properties.push({ id: propId, type, materialId: matId, thickness: sec.thickness, planeFormulation })
  }

  // Fall-back: if no sections were found, create one PSOLID property
  if (properties.length === 0 && materials.length > 0) {
    properties.push({ id: 1, type: 'PSOLID', materialId: materials[0].id })
    for (const elset of elemSets.keys()) elsetToPropId.set(elset, 1)
  }

  // Assign property IDs to elements
  for (const el of elements) {
    outer: for (const [elsetName, propId] of elsetToPropId) {
      for (const eid of elemSets.get(elsetName) ?? []) {
        if (eid === el.id) { el.propertyId = propId; break outer }
      }
    }
    if (el.propertyId === 0) el.propertyId = properties[0]?.id ?? 1
  }

  return { nodes, elements, materials, properties, constraints, loads, modelName }
}

// ── Display helpers (used by ModelTree / PropertiesPanel) ─────────────────────

export const DOF_LABEL = DOF_NAMES

export interface BcGroup {
  dofLabel: string   // e.g. "Ux, Uy, Uz"
  value: number
  nodeCount: number
}

export interface LoadGroup {
  dofLabel: string
  total: number
  nodeCount: number
}

export function groupConstraints(constraints: Constraint[]): BcGroup[] {
  // node → set of (dof, value) pairs
  const nodeMap = new Map<number, Map<number, number>>()
  for (const c of constraints) {
    if (!nodeMap.has(c.nodeId)) nodeMap.set(c.nodeId, new Map())
    nodeMap.get(c.nodeId)!.set(c.dof, c.prescribedValue ?? 0)
  }
  // Group nodes sharing the same (dofs, value) signature
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
    const value = pairs[0]?.value ?? 0
    const dofLabel = pairs.map(p => DOF_NAMES[p.dof]).join(', ')
    return { dofLabel, value, nodeCount }
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
    dofLabel: DOF_NAMES[dof],
    total: g.total,
    nodeCount: g.nodes.size,
  }))
}

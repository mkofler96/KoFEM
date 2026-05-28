/// <reference lib="webworker" />
// Runs kofem-wasm off the main thread so heavy solves don't freeze the UI.

// import init, {
//   tessellate_step,
//   generate_volume_mesh,
//   solve_linear_elastic,
// } from '/wasm/pkg/kofem_wasm.js'
import createModule from '../wasm/pkg/kofem_wasm.js'


let Module: any = null
async function ensureInit() {
  if (!Module) {
    Module = await createModule()
  }
}

// ── Payload types ─────────────────────────────────────────────────────────────

interface Node { id: number; x: number; y: number; z: number }
interface Element { id: number; type: string; nodeIds: [number, number, number, number]; propertyId: number }
interface Material { id: number; name: string; young: number; poisson: number; density: number }
interface Constraint { nodeId: number; dof: number; prescribedValue?: number }
interface Load { nodeId: number; dof: number; value: number }

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data

  try {
    await ensureInit()

    if (type === 'parse_step') {
      // payload.bytes: Uint8Array
      const opts = JSON.stringify({ linear_deflection: 0.1, angular_deflection: 0.5 })
      const json = Module.tessellate_step(payload.bytes as Uint8Array, opts)
      const dto = JSON.parse(json) as { vertices: [number, number, number][]; triangles: [number, number, number][] }
      // Return as {points, triangles} to match the StepSurfaceMesh type used by the store
      self.postMessage({ id, ok: true, points: dto.vertices, triangles: dto.triangles })

    } else if (type === 'volume_mesh') {
      // payload.surface: { points: [number,number,number][], triangles: [number,number,number][] }
      const surface = {
        vertices: payload.surface.points as [number, number, number][],
        triangles: payload.surface.triangles as [number, number, number][],
      }
      const opts = JSON.stringify({ max_element_size: 10.0, min_element_size: 0.1, grading: 0.3, second_order: false })
      const json = Module.generate_volume_mesh(JSON.stringify(surface), opts)
      const dto = JSON.parse(json) as { vertices: [number, number, number][]; tetrahedra: [number, number, number, number][] }

      const nodes: Node[] = dto.vertices.map(([x, y, z], i) => ({ id: i, x, y, z }))
      const elements: Element[] = dto.tetrahedra.map((v, i) => ({
        id: i, type: 'CTETRA', nodeIds: v, propertyId: 1,
      }))

      // Derive unique edges from tetrahedra for wireframe display
      const edgeSet = new Set<string>()
      const edges: [number, number][] = []
      for (const [a, b, c, d] of dto.tetrahedra) {
        for (const [u, v] of [[a, b], [a, c], [a, d], [b, c], [b, d], [c, d]] as [number, number][]) {
          const key = u < v ? `${u}-${v}` : `${v}-${u}`
          if (!edgeSet.has(key)) { edgeSet.add(key); edges.push([u, v]) }
        }
      }

      self.postMessage({ id, ok: true, points: dto.vertices, edges, nodes, elements })

    } else if (type === 'solve') {
      const { nodes, elements, materials, constraints, loads } = payload as {
        nodes: Node[]
        elements: Element[]
        materials: Material[]
        properties: unknown[]
        constraints: Constraint[]
        loads: Load[]
      }

      // Map store model format → MFEM bridge format
      const mesh = {
        vertices: nodes.map(n => [n.x, n.y, n.z]),
        tetrahedra: elements.map(e => e.nodeIds),
      }

      const mat = materials[0] ?? { young: 210e9, poisson: 0.3, density: 7850 }
      const material = { young_modulus: mat.young, poisson_ratio: mat.poisson, density: mat.density }

      // A node is fully fixed if it has any translational DOF constraint (DOFs 0–2).
      // The MFEM bridge fixes all 3 translational DOFs for each listed vertex.
      const fixedNodeIds = new Set(constraints.filter(c => c.dof <= 2).map(c => c.nodeId))
      const fixed_vertices = [...fixedNodeIds]

      // Group translational force loads by node, accumulating into [fx, fy, fz]
      const loadMap = new Map<number, [number, number, number]>()
      for (const load of loads) {
        if (load.dof > 2) continue
        if (!loadMap.has(load.nodeId)) loadMap.set(load.nodeId, [0, 0, 0])
        loadMap.get(load.nodeId)![load.dof] += load.value
      }
      const point_loads = [...loadMap.entries()].map(([vertex, force]) => ({ vertex, force }))

      const bcs = { fixed_vertices, point_loads }
      const json = Module.solve_linear_elastic(
        JSON.stringify(mesh),
        JSON.stringify(material),
        JSON.stringify(bcs),
        1,
      )
      const result = JSON.parse(json) as { displacements: number[]; von_mises: number[] }
      self.postMessage({ id, ok: true, displacements: result.displacements, vonMises: result.von_mises })

    } else if (type === 'parse') {
      throw new Error(
        '.inp file import is not supported in the OCCT-based pipeline. Please import a STEP file instead.'
      )

    } else if (type === 'mesh') {
      throw new Error(
        'Parametric mesh generation is not available in the new pipeline. Import a STEP file instead.'
      )

    } else {
      throw new Error(`Unknown worker message type: ${type}`)
    }
  } catch (err) {
    const detail = err instanceof Error
      ? `${err.name}: ${err.message}\n${err.stack ?? ''}`
      : String(err)
    self.postMessage({ id, ok: false, error: detail })
  }
}

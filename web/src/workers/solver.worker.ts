/// <reference lib="webworker" />
// Runs kofem-wasm off the main thread so heavy solves don't freeze the UI.

// import init, {
//   tessellate_step,
//   generate_volume_mesh,
//   solve_linear_elastic,
// } from '/wasm/pkg/kofem_wasm.js'
import createModule from '../wasm/pkg/kofem_wasm.js'
import type { KofemModule } from '../wasm/pkg/kofem_wasm.js'

let Module: KofemModule | null = null
async function ensureInit() {
  if (!Module) {
    Module = await createModule({
      print:    (text: string) => self.postMessage({ id: 0, log: `[wasm] ${text}` }),
      printErr: (text: string) => self.postMessage({ id: 0, log: `[wasm:err] ${text}` }),
    })
  }
}
function m(): KofemModule {
  if (!Module) throw new Error('WASM module not initialised — await ensureInit() first')
  return Module
}

// ── Payload types ─────────────────────────────────────────────────────────────

interface Node { id: number; x: number; y: number; z: number }
interface Element { id: number; type: string; nodeIds: number[]; propertyId: number }
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
      const json = m().tessellate_step(payload.bytes as Uint8Array, opts)
      const dto = JSON.parse(json) as { vertices: [number, number, number][]; triangles: [number, number, number][] }
      // Return as {points, triangles} to match the StepSurfaceMesh type used by the store
      self.postMessage({ id, ok: true, points: dto.vertices, triangles: dto.triangles })

    } else if (type === 'volume_mesh') {
      const { maxElementSize = 20.0 } = payload as {
        surface?: unknown
        maxElementSize?: number
      }

      const opts = JSON.stringify({
        max_element_size: maxElementSize, min_element_size: 0.0, grading: 0.3,
        second_order: false, elementsperedge: 2.0, elementspercurve: 2.0,
        optsteps_2d: 3, optsteps_3d: 3,
      })

      // Use Netgen's native OCC mesher: reads the stored STEP geometry directly,
      // generates a proper FEM surface mesh respecting CAD topology (edges, faces,
      // feature lines), then fills the volume — all in one pass.
      self.postMessage({ id, log: `Generating FEM mesh via Netgen OCC (max element size: ${maxElementSize} mm)…` })
      const json = m().generate_fem_mesh(opts)
      const dto = JSON.parse(json) as {
        vertices: [number, number, number][]
        tetrahedra: [number, number, number, number][]
        surfaceFaceIds?: number[]   // OCC face index per surface triangle (1-based), present when
                                    // Netgen was built with USE_OCC and exposes Ng_GetSurfaceElementBCProperty
      }

      self.postMessage({ id, log: `Volume mesh complete: ${dto.vertices.length} nodes, ${dto.tetrahedra.length} tetrahedra` })

      // Release OCCT shape + STEP bytes from WASM heap — they are no longer
      // needed once meshing is done, and freeing them before the solve gives
      // MFEM more headroom for stiffness-matrix assembly.
      m().free_geometry_cache()

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

      self.postMessage({ id, log: `Wireframe: ${edges.length} edges built` })

      self.postMessage({ id, ok: true, points: dto.vertices, edges, nodes, elements,
        surfaceFaceIds: dto.surfaceFaceIds ?? null })

    } else if (type === 'solve') {
      const { nodes, elements, materials, constraints, loads } = payload as {
        nodes: Node[]
        elements: Element[]
        materials: Material[]
        properties: unknown[]
        constraints: Constraint[]
        loads: Load[]
      }

      const tetrahedra = elements.filter(e => e.type === 'CTETRA').map(e => e.nodeIds)
      const hexahedra  = elements.filter(e => e.type === 'CHEXA').map(e => e.nodeIds)
      if (tetrahedra.length === 0 && hexahedra.length === 0) {
        throw new Error(
          'No supported elements found. MFEM requires CTETRA or CHEXA elements — ' +
          'import a STEP file and click "Mesh STEP volume" first.'
        )
      }
      const mesh = {
        vertices: nodes.map(n => [n.x, n.y, n.z]),
        tetrahedra,
        hexahedra,
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
      const json = m().solve_linear_elastic(
        JSON.stringify(mesh),
        JSON.stringify(material),
        JSON.stringify(bcs),
        1,
      )
      const result = JSON.parse(json) as { displacements: number[]; von_mises: number[] }
      self.postMessage({ id, ok: true, displacements: result.displacements, vonMises: result.von_mises })

    } else if (type === 'test_netgen') {
      // Minimal 4-triangle tetrahedron surface — quick smoke test for Netgen WASM.
      const surface = {
        vertices: [[0,0,0],[10,0,0],[5,8.66,0],[5,2.89,8.165]] as [number,number,number][],
        triangles: [[0,2,1],[0,1,3],[1,2,3],[0,3,2]] as [number,number,number][],
      }
      self.postMessage({ id, log: 'test_netgen: meshing 4-triangle tetrahedron…' })
      const t0 = Date.now()
      const opts = JSON.stringify({
        max_element_size: 20.0, min_element_size: 2.0, grading: 0.5, second_order: false,
        uselocalh: 0, elementsperedge: 1.0, elementspercurve: 1.0, optsteps_2d: 0, optsteps_3d: 0,
      })
      const json = m().generate_volume_mesh(JSON.stringify(surface), opts)
      const durationMs = Date.now() - t0
      const dto = JSON.parse(json) as { vertices: unknown[]; tetrahedra: unknown[] }
      self.postMessage({ id, ok: true, nodes: dto.vertices.length, elements: dto.tetrahedra.length, durationMs })

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
    const isRuntimeError = err instanceof Error && err.name === 'RuntimeError'
    const isWasmTrap     = isRuntimeError && (
      err.message.includes('memory access out of bounds') ||
      err.message.includes('integer overflow') ||
      err.message.includes('integer divide by zero') ||
      err.message.includes('unreachable') ||
      err.message.includes('null function or function signature mismatch') ||
      err.message.includes('table index is out of bounds')
    )
    const detail = err instanceof Error
      ? `${err.name}: ${err.message}\n${err.stack ?? ''}`
      : String(err)
    const errorMessage = isWasmTrap
      ? `WASM trap (code bug, not OOM): ${detail}`
      : detail
    if (isWasmTrap) {
      console.error(`[solver.worker] WASM trap in ${type}:`, detail)
    } else {
      console.error(`[solver.worker] ${type} failed:`, detail)
    }
    self.postMessage({ id, ok: false, error: errorMessage })
  }
}

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
    Module = await createModule({
      print:    (text: string) => self.postMessage({ id: 0, log: `[wasm] ${text}` }),
      printErr: (text: string) => self.postMessage({ id: 0, log: `[wasm:err] ${text}` }),
    })
  }
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
      const json = Module.tessellate_step(payload.bytes as Uint8Array, opts)
      const dto = JSON.parse(json) as { vertices: [number, number, number][]; triangles: [number, number, number][] }
      // Return as {points, triangles} to match the StepSurfaceMesh type used by the store
      self.postMessage({ id, ok: true, points: dto.vertices, triangles: dto.triangles })

    } else if (type === 'volume_mesh') {
      const { maxElementSize = 20.0 } = payload as {
        surface?: unknown
        maxElementSize?: number
      }

      const opts = JSON.stringify({
        max_element_size: maxElementSize, min_element_size: 0.0, grading: 0.3, second_order: false,
        uselocalh: 1, elementsperedge: 2.0, elementspercurve: 2.0,
        optsteps_2d: 3, optsteps_3d: 3,
      })

      // Re-tessellate the stored STEP shape with parameters tuned to the
      // target element size (linear_defl ≈ max_element_size/4).  The
      // visualization tessellation (linear_deflection=0.1) produces many tiny
      // triangles that are orders of magnitude smaller than the volume elements;
      // this size mismatch triggers memory-access crashes in Netgen's
      // advancing-front mesher on complex geometry.
      self.postMessage({ id, log: `Re-tessellating STEP shape for mesh quality (max size: ${maxElementSize} mm)…` })
      const qualityJson = Module.tessellate_for_meshing(opts)
      const qualityDto = JSON.parse(qualityJson) as { vertices: [number,number,number][]; triangles: [number,number,number][] }
      const surface = { vertices: qualityDto.vertices, triangles: qualityDto.triangles }
      self.postMessage({ id, log: `Quality surface: ${surface.vertices.length} vertices, ${surface.triangles.length} triangles` })

      // OCCT tessellates each face independently, emitting duplicate vertices at
      // shared edges.  Deduplicate by snapping to a 1e-4 grid.
      const PREC = 1e-4
      const keyFor = ([x, y, z]: [number, number, number]) =>
        `${Math.round(x / PREC)},${Math.round(y / PREC)},${Math.round(z / PREC)}`
      const vertMap = new Map<string, number>()
      const dedupVerts: [number, number, number][] = []
      const remap = new Int32Array(surface.vertices.length)
      for (let i = 0; i < surface.vertices.length; i++) {
        const k = keyFor(surface.vertices[i])
        if (!vertMap.has(k)) { vertMap.set(k, dedupVerts.length); dedupVerts.push(surface.vertices[i]) }
        remap[i] = vertMap.get(k)!
      }
      const dedupTris = surface.triangles
        .map(([a, b, c]) => [remap[a], remap[b], remap[c]] as [number, number, number])
        .filter(([a, b, c]) => a !== b && b !== c && a !== c)
      self.postMessage({ id, log: `Deduped: ${surface.vertices.length}→${dedupVerts.length} vertices, ${surface.triangles.length}→${dedupTris.length} triangles` })
      const manifoldSurface = { vertices: dedupVerts, triangles: dedupTris }

      self.postMessage({ id, log: 'Calling Netgen volume mesher…' })

      const json = Module.generate_volume_mesh(JSON.stringify(manifoldSurface), opts)
      const dto = JSON.parse(json) as { vertices: [number, number, number][]; tetrahedra: [number, number, number, number][] }

      self.postMessage({ id, log: `Volume mesh complete: ${dto.vertices.length} nodes, ${dto.tetrahedra.length} tetrahedra` })

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
      const json = Module.solve_linear_elastic(
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
      const json = Module.generate_volume_mesh(JSON.stringify(surface), opts)
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
    const detail = err instanceof Error
      ? `${err.name}: ${err.message}\n${err.stack ?? ''}`
      : String(err)
    self.postMessage({ id, ok: false, error: detail })
  }
}

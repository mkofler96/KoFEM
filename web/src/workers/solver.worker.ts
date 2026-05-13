/// <reference lib="webworker" />
// Runs kofem-wasm off the main thread so heavy solves don't freeze the UI.

import init, {
  solve_linear_static,
  parse_inp_model,
  mesh_polygon,
  extrude_mesh,
} from '../wasm/pkg/kofem_wasm'

let initialized = false

async function ensureInit() {
  if (!initialized) {
    await init()
    initialized = true
  }
}

interface BoxGeometry {
  ox: number; oy: number; oz: number
  sketchWidth: number; sketchHeight: number
  sketchNormal: 'X' | 'Y' | 'Z'
  extrudeSign: 1 | -1; extrudeLength: number
  meshNu: number; meshNv: number; meshNw: number
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data

  try {
    await ensureInit()

    if (type === 'solve') {
      const modelJson = JSON.stringify(payload)
      const displacements = solve_linear_static(modelJson)
      self.postMessage({ id, ok: true, displacements: Array.from(displacements) })

    } else if (type === 'parse') {
      const modelJson = parse_inp_model(payload.text)
      self.postMessage({ id, ok: true, model: JSON.parse(modelJson) })

    } else if (type === 'mesh') {
      const geom = payload as BoxGeometry
      const { ox, oy, oz, sketchWidth: W, sketchHeight: H,
              extrudeLength: L, extrudeSign, sketchNormal, meshNw } = geom

      // CCW rectangle in canonical UV space (always extrude along +Z internally)
      const polygon = [
        { x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H },
      ]

      const mesh2dJson = mesh_polygon(JSON.stringify(polygon), 25, 5000)
      const mesh3dJson = extrude_mesh(mesh2dJson, 0, 0, L, meshNw)
      const mesh3d = JSON.parse(mesh3dJson) as {
        points: { x: number; y: number; z: number }[]
        tets: { v: [number, number, number, number] }[]
      }

      // Remap canonical (u, v, w) → world (x, y, z) based on sketch plane
      const nodes = mesh3d.points.map((p, i) => {
        const [u, v, w] = [p.x, p.y, p.z]
        let x: number, y: number, z: number
        if (sketchNormal === 'Z') {
          x = ox + u; y = oy + v; z = oz + extrudeSign * w
        } else if (sketchNormal === 'X') {
          x = ox + extrudeSign * w; y = oy + u; z = oz + v
        } else {
          x = ox + u; y = oy + extrudeSign * w; z = oz + v
        }
        return { id: i, x, y, z }
      })

      const elements = mesh3d.tets.map((t, i) => ({
        id: i,
        type: 'CTETRA' as const,
        nodeIds: t.v,
        propertyId: 1,
      }))

      self.postMessage({ id, ok: true, nodes, elements })
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) })
  }
}

import type { Node, Element } from '../store/modelStore'

export interface BoxMeshParams {
  ox: number; oy: number; oz: number
  lx: number; ly: number; lz: number
  nx: number; ny: number; nz: number
}

export function meshFromBox(
  { ox, oy, oz, lx, ly, lz, nx, ny, nz }: BoxMeshParams,
  startNodeId = 0,
  startElemId = 0,
): { nodes: Node[]; elements: Element[] } {
  const dx = lx / nx, dy = ly / ny, dz = lz / nz
  const sZ = nz + 1
  const sX = (ny + 1) * (nz + 1)
  const nid = (ix: number, iy: number, iz: number) =>
    startNodeId + ix * sX + iy * sZ + iz

  const nodes: Node[] = []
  for (let ix = 0; ix <= nx; ix++)
    for (let iy = 0; iy <= ny; iy++)
      for (let iz = 0; iz <= nz; iz++)
        nodes.push({ id: nid(ix, iy, iz), x: ox + ix * dx, y: oy + iy * dy, z: oz + iz * dz })

  const elements: Element[] = []
  let eid = startElemId
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

  return { nodes, elements }
}

export function geomToBoxParams(g: {
  ox: number; oy: number; oz: number
  sketchWidth: number; sketchHeight: number
  sketchNormal: 'X' | 'Y' | 'Z'
  extrudeSign: 1 | -1; extrudeLength: number
  meshNu: number; meshNv: number; meshNw: number
}): BoxMeshParams {
  const { ox, oy, oz, sketchWidth, sketchHeight, extrudeLength, extrudeSign } = g
  const dep = extrudeLength

  switch (g.sketchNormal) {
    case 'X': {
      const x0 = extrudeSign > 0 ? ox : ox - dep
      return { ox: x0, oy, oz, lx: dep, ly: sketchWidth, lz: sketchHeight,
               nx: g.meshNw, ny: g.meshNu, nz: g.meshNv }
    }
    case 'Y': {
      const y0 = extrudeSign > 0 ? oy : oy - dep
      return { ox, oy: y0, oz, lx: sketchWidth, ly: dep, lz: sketchHeight,
               nx: g.meshNu, ny: g.meshNw, nz: g.meshNv }
    }
    case 'Z': {
      const z0 = extrudeSign > 0 ? oz : oz - dep
      return { ox, oy, oz: z0, lx: sketchWidth, ly: sketchHeight, lz: dep,
               nx: g.meshNu, ny: g.meshNv, nz: g.meshNw }
    }
  }
}

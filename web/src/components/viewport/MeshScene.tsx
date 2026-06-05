import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import { useModelStore } from '../../store/modelStore'

const TARGET_DEFORM_FRACTION = 0.20
// Transitions between adjacent boundary triangles smoother than this angle
// belong to the same surface feature (flat face or cylinder/fillet).
// 89° handles any cylinder (including coarse tet meshes where adjacent boundary
// triangles on the same curved surface can differ by up to ~88°) while still
// stopping at true sharp 90° edges (e.g. cylinder wall meeting its end cap).
const FEATURE_ANGLE_RAD = 89 * Math.PI / 180

// ── CHEXA geometry ────────────────────────────────────────────────────────────

const HEX_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
]

const HEX_FACE_DEFS: [number, number, number, number][] = [
  [0, 1, 2, 3], [4, 5, 6, 7],
  [0, 1, 5, 4], [2, 3, 7, 6],
  [0, 3, 7, 4], [1, 2, 6, 5],
]


function extractBoundaryQuadFaceIds(hexElems: { nodeIds: number[] }[]): [number, number, number, number][] {
  const faceMap = new Map<string, { face: [number, number, number, number]; count: number }>()
  for (const el of hexElems) {
    for (const [a, b, c, d] of HEX_FACE_DEFS) {
      const face: [number, number, number, number] = [el.nodeIds[a], el.nodeIds[b], el.nodeIds[c], el.nodeIds[d]]
      const key = [...face].sort((x, y) => x - y).join(',')
      const entry = faceMap.get(key)
      if (entry) { entry.count++ } else { faceMap.set(key, { face, count: 1 }) }
    }
  }
  return [...faceMap.values()].filter(e => e.count === 1).map(e => e.face)
}

// ── CTETRA geometry ───────────────────────────────────────────────────────────

const TET_EDGES: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
]

const TET_FACE_DEFS: [number, number, number][] = [
  [0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3],
]


function extractBoundaryTriFaceIds(tetElems: { nodeIds: number[] }[]): [number, number, number][] {
  const faceMap = new Map<string, { face: [number, number, number]; count: number }>()
  for (const el of tetElems) {
    for (const [a, b, c] of TET_FACE_DEFS) {
      const face: [number, number, number] = [el.nodeIds[a], el.nodeIds[b], el.nodeIds[c]]
      const key = [...face].sort((x, y) => x - y).join(',')
      const entry = faceMap.get(key)
      if (entry) { entry.count++ } else { faceMap.set(key, { face, count: 1 }) }
    }
  }
  return [...faceMap.values()].filter(e => e.count === 1).map(e => e.face)
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MeshScene() {
  const nodes = useModelStore(s => s.nodes)
  const elements = useModelStore(s => s.elements)
  const constraints = useModelStore(s => s.constraints)
  const loads = useModelStore(s => s.loads)
  const result = useModelStore(s => s.result)
  const stepSurface = useModelStore(s => s.stepSurface)
  const volMesh = useModelStore(s => s.volMesh)
  const viewRepr = useModelStore(s => s.viewRepr)
  const pickMode = useModelStore(s => s.pickMode)
  const selectedFace = useModelStore(s => s.selectedFace)
  const setSelectedFace = useModelStore(s => s.setSelectedFace)

  const nodeMap = useMemo(
    () => new Map(nodes.map((n, i) => [n.id, { n, i }])),
    [nodes],
  )

  const modelSize = useMemo(() => {
    if (nodes.length === 0) return 1
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
    for (const n of nodes) {
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y
      if (n.z < minZ) minZ = n.z; if (n.z > maxZ) maxZ = n.z
    }
    return Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-9)
  }, [nodes])

  const deformScale = useMemo(() => {
    if (!result) return 1
    let maxDisp = 0
    for (let i = 0; i < result.displacements.length; i++) {
      const v = Math.abs(result.displacements[i])
      if (v > maxDisp) maxDisp = v
    }
    if (maxDisp < 1e-30) return 1
    return (TARGET_DEFORM_FRACTION * modelSize) / maxDisp
  }, [result, modelSize])

  const hexElements = useMemo(() => elements.filter(e => e.type === 'CHEXA'), [elements])
  const tetElements = useMemo(() => elements.filter(e => e.type === 'CTETRA'), [elements])
  const barElements = useMemo(() => elements.filter(e => e.type === 'CBAR' || e.type === 'CBEAM'), [elements])

  const boundaryQuadFaceIds = useMemo(() => extractBoundaryQuadFaceIds(hexElements), [hexElements])
  const boundaryTriFaceIds = useMemo(() => extractBoundaryTriFaceIds(tetElements), [tetElements])

  // Boundary mesh topology for flood-fill face picking.
  // Triangle order matches the undeformedSurface BufferGeometry exactly so that
  // e.faceIndex from raycasting maps directly into this triangles array.
  const boundaryMeshTopo = useMemo(() => {
    const triangles: [number, number, number][] = []
    for (const [a, b, c, d] of boundaryQuadFaceIds) {
      triangles.push([a, b, c], [a, c, d])
    }
    for (const [a, b, c] of boundaryTriFaceIds) {
      triangles.push([a, b, c])
    }
    if (triangles.length === 0) return null

    // Edge → triangle indices for adjacency lookup
    const edgeToTris = new Map<string, number[]>()
    for (let i = 0; i < triangles.length; i++) {
      const [a, b, c] = triangles[i]
      for (const [x, y] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const key = x < y ? `${x},${y}` : `${y},${x}`
        const list = edgeToTris.get(key)
        if (list) list.push(i)
        else edgeToTris.set(key, [i])
      }
    }

    // Per-triangle face normals
    const triNormals = triangles.map(([a, b, c]) => {
      const na = nodeMap.get(a)?.n, nb = nodeMap.get(b)?.n, nc = nodeMap.get(c)?.n
      if (!na || !nb || !nc) return new THREE.Vector3(0, 1, 0)
      const AB = new THREE.Vector3(nb.x - na.x, nb.y - na.y, nb.z - na.z)
      const AC = new THREE.Vector3(nc.x - na.x, nc.y - na.y, nc.z - na.z)
      return AB.cross(AC).normalize()
    })

    return { triangles, edgeToTris, triNormals }
  }, [boundaryQuadFaceIds, boundaryTriFaceIds, nodeMap])

  const undeformedEdgePositions = useMemo(() => {
    const segs: number[] = []
    const coord = (id: number) => { const e = nodeMap.get(id)!; return [e.n.x, e.n.y, e.n.z] }
    for (const el of hexElements) {
      for (const [a, b] of HEX_EDGES) { segs.push(...coord(el.nodeIds[a]), ...coord(el.nodeIds[b])) }
    }
    for (const el of tetElements) {
      for (const [a, b] of TET_EDGES) { segs.push(...coord(el.nodeIds[a]), ...coord(el.nodeIds[b])) }
    }
    return segs.length > 0 ? new Float32Array(segs) : null
  }, [hexElements, tetElements, nodeMap])

  const deformedEdgePositions = useMemo(() => {
    if (!result) return null
    const d = result.displacements
    const coord = (id: number) => {
      const { n, i } = nodeMap.get(id)!
      return [n.x + (d[i * 3] ?? 0) * deformScale, n.y + (d[i * 3 + 1] ?? 0) * deformScale, n.z + (d[i * 3 + 2] ?? 0) * deformScale]
    }
    const segs: number[] = []
    for (const el of hexElements) {
      for (const [a, b] of HEX_EDGES) { segs.push(...coord(el.nodeIds[a]), ...coord(el.nodeIds[b])) }
    }
    for (const el of tetElements) {
      for (const [a, b] of TET_EDGES) { segs.push(...coord(el.nodeIds[a]), ...coord(el.nodeIds[b])) }
    }
    return segs.length > 0 ? new Float32Array(segs) : null
  }, [result, hexElements, tetElements, nodeMap, deformScale])

  const barLines = useMemo(() => barElements.map(el =>
    el.nodeIds.map(id => { const e = nodeMap.get(id)!; return [e.n.x, e.n.y, e.n.z] as [number, number, number] }),
  ), [barElements, nodeMap])

  const deformedSurface = useMemo(() => {
    if (!result) return null
    const hasQuads = boundaryQuadFaceIds.length > 0
    const hasTris = boundaryTriFaceIds.length > 0
    if (!hasQuads && !hasTris) return null

    const d = result.displacements
    const positions: number[] = []
    const colors: number[] = []
    let minUy = Infinity, maxUy = -Infinity
    nodes.forEach((_, i) => { const uy = d[i * 3 + 1] ?? 0; if (uy < minUy) minUy = uy; if (uy > maxUy) maxUy = uy })
    const range = maxUy - minUy || 1

    const deformedPos = (id: number): [number, number, number] => {
      const { n, i } = nodeMap.get(id)!
      return [n.x + (d[i * 3] ?? 0) * deformScale, n.y + (d[i * 3 + 1] ?? 0) * deformScale, n.z + (d[i * 3 + 2] ?? 0) * deformScale]
    }
    const nodeColor = (id: number): [number, number, number] => {
      const { i } = nodeMap.get(id)!
      const t = ((d[i * 3 + 1] ?? 0) - minUy) / range
      const c = new THREE.Color(); c.setHSL(0.667 * (1 - t), 1, 0.5)
      return [c.r, c.g, c.b]
    }

    for (const [a, b, c_, dd] of boundaryQuadFaceIds) {
      const pa = deformedPos(a), pb = deformedPos(b), pc = deformedPos(c_), pd = deformedPos(dd)
      const ca = nodeColor(a), cb = nodeColor(b), cc = nodeColor(c_), cd = nodeColor(dd)
      positions.push(...pa, ...pb, ...pc, ...pa, ...pc, ...pd)
      colors.push(...ca, ...cb, ...cc, ...ca, ...cc, ...cd)
    }
    for (const [a, b, c_] of boundaryTriFaceIds) {
      const pa = deformedPos(a), pb = deformedPos(b), pc = deformedPos(c_)
      const ca = nodeColor(a), cb = nodeColor(b), cc = nodeColor(c_)
      positions.push(...pa, ...pb, ...pc)
      colors.push(...ca, ...cb, ...cc)
    }

    return { positions: new Float32Array(positions), colors: new Float32Array(colors) }
  }, [result, boundaryQuadFaceIds, boundaryTriFaceIds, nodeMap, nodes, deformScale])

  // Undeformed surface for face picking
  const undeformedSurface = useMemo(() => {
    const hasQuads = boundaryQuadFaceIds.length > 0
    const hasTris = boundaryTriFaceIds.length > 0
    if (!hasQuads && !hasTris) return null

    const positions: number[] = []
    const normals: number[] = []

    const p = (n: { x: number; y: number; z: number }) => [n.x, n.y, n.z] as [number, number, number]

    for (const [a, b, c_, dd] of boundaryQuadFaceIds) {
      const pa = nodeMap.get(a)!.n, pb = nodeMap.get(b)!.n
      const pc = nodeMap.get(c_)!.n, pd = nodeMap.get(dd)!.n
      positions.push(...p(pa), ...p(pb), ...p(pc), ...p(pa), ...p(pc), ...p(pd))
      const AB = new THREE.Vector3(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z)
      const AC = new THREE.Vector3(pc.x - pa.x, pc.y - pa.y, pc.z - pa.z)
      const norm = AB.cross(AC).normalize()
      for (let k = 0; k < 6; k++) normals.push(norm.x, norm.y, norm.z)
    }
    for (const [a, b, c_] of boundaryTriFaceIds) {
      const pa = nodeMap.get(a)!.n, pb = nodeMap.get(b)!.n, pc = nodeMap.get(c_)!.n
      positions.push(...p(pa), ...p(pb), ...p(pc))
      const AB = new THREE.Vector3(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z)
      const AC = new THREE.Vector3(pc.x - pa.x, pc.y - pa.y, pc.z - pa.z)
      const norm = AB.cross(AC).normalize()
      for (let k = 0; k < 3; k++) normals.push(norm.x, norm.y, norm.z)
    }

    return { positions: new Float32Array(positions), normals: new Float32Array(normals) }
  }, [boundaryQuadFaceIds, boundaryTriFaceIds, nodeMap])

  // Selected face highlight — build a triangle mesh from boundary triangles
  // whose vertices are all in the selection, then render as a colour overlay.
  const selectedFacePositions = useMemo(() => {
    if (!selectedFace || !boundaryMeshTopo) return null
    const nodeIdSet = new Set(selectedFace.nodeIds)
    const positions: number[] = []
    for (const [a, b, c] of boundaryMeshTopo.triangles) {
      if (!nodeIdSet.has(a) || !nodeIdSet.has(b) || !nodeIdSet.has(c)) continue
      const na = nodeMap.get(a)?.n, nb = nodeMap.get(b)?.n, nc = nodeMap.get(c)?.n
      if (!na || !nb || !nc) continue
      positions.push(na.x, na.y, na.z, nb.x, nb.y, nb.z, nc.x, nc.y, nc.z)
    }
    return positions.length > 0 ? new Float32Array(positions) : null
  }, [selectedFace, boundaryMeshTopo, nodeMap])

  // Face picking handler — BFS flood-fill along boundary mesh topology.
  // Starting from the clicked triangle (e.faceIndex), expands to all adjacent
  // triangles whose normal differs by less than FEATURE_ANGLE_RAD. This selects
  // entire flat faces AND cylindrical / filleted surfaces in one click, while
  // stopping at sharp feature edges (e.g. where a cylinder meets its end cap).
  function handleFacePick(e: ThreeEvent<MouseEvent>) {
    if (!pickMode || e.faceIndex == null || !boundaryMeshTopo) return
    e.stopPropagation()

    const { triangles, edgeToTris, triNormals } = boundaryMeshTopo
    const startIdx = e.faceIndex
    if (startIdx >= triangles.length) return

    const visited = new Set<number>([startIdx])
    const queue = [startIdx]
    const nodeIds = new Set<number>()

    while (queue.length > 0) {
      const triIdx = queue.shift()!
      const [a, b, c] = triangles[triIdx]
      nodeIds.add(a); nodeIds.add(b); nodeIds.add(c)

      const n = triNormals[triIdx]
      for (const [x, y] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const key = x < y ? `${x},${y}` : `${y},${x}`
        for (const ni of edgeToTris.get(key) ?? []) {
          if (visited.has(ni)) continue
          if (n.angleTo(triNormals[ni]) < FEATURE_ANGLE_RAD) {
            visited.add(ni)
            queue.push(ni)
          }
        }
      }
    }

    const faceNodeIds = [...nodeIds]
    const normal = e.face?.normal.clone().normalize() ?? new THREE.Vector3(0, 1, 0)
    const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z)
    let axis: 'X' | 'Y' | 'Z'
    let isMax: boolean
    if (ax >= ay && ax >= az) { axis = 'X'; isMax = normal.x > 0 }
    else if (ay >= ax && ay >= az) { axis = 'Y'; isMax = normal.y > 0 }
    else { axis = 'Z'; isMax = normal.z > 0 }

    setSelectedFace({
      nodeIds: faceNodeIds,
      label: `face (${faceNodeIds.length} nodes)`,
      axis,
      isMax,
    })
  }

  // BC marker: centroid + quaternion that orients triangles outward from the model
  const bcMarkerData = useMemo(() => {
    if (constraints.length === 0 || nodes.length === 0) return null
    const ids = new Set(constraints.map(c => c.nodeId))
    let cx = 0, cy = 0, cz = 0, count = 0
    for (const id of ids) {
      const e = nodeMap.get(id)
      if (e) { cx += e.n.x; cy += e.n.y; cz += e.n.z; count++ }
    }
    if (count === 0) return null
    cx /= count; cy /= count; cz /= count

    // Outward normal: direction from model centroid toward BC face centroid
    let mx = 0, my = 0, mz = 0
    for (const n of nodes) { mx += n.x; my += n.y; mz += n.z }
    mx /= nodes.length; my /= nodes.length; mz /= nodes.length
    const dx = cx - mx, dy = cy - my, dz = cz - mz
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
    const outward = new THREE.Vector3(dx / len, dy / len, dz / len)

    // Rotate group so that -Y (cone base direction) aligns with outward normal
    const q = new THREE.Quaternion()
    q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), outward)
    return { pos: [cx, cy, cz] as [number, number, number], quaternion: q }
  }, [constraints, nodeMap, nodes])

  // Load arrow: single resultant of all force DOFs, placed at centroid of loaded nodes
  const loadArrowData = useMemo(() => {
    if (loads.length === 0) return null
    let cx = 0, cy = 0, cz = 0, nodeCount = 0
    let fx = 0, fy = 0, fz = 0
    const seen = new Set<number>()
    for (const l of loads) {
      if (l.dof === 0) fx += l.value
      else if (l.dof === 1) fy += l.value
      else if (l.dof === 2) fz += l.value
      else continue
      if (!seen.has(l.nodeId)) {
        const e = nodeMap.get(l.nodeId)
        if (e) { cx += e.n.x; cy += e.n.y; cz += e.n.z; nodeCount++ }
        seen.add(l.nodeId)
      }
    }
    if (nodeCount === 0) return null
    const len = Math.sqrt(fx * fx + fy * fy + fz * fz)
    if (len < 1e-30) return null
    const dir = new THREE.Vector3(fx / len, fy / len, fz / len)
    const q = new THREE.Quaternion()
    q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    return { pos: [cx / nodeCount, cy / nodeCount, cz / nodeCount] as [number, number, number], quaternion: q }
  }, [loads, nodeMap])

  const volMeshPositions = useMemo(() => {
    if (!volMesh || viewRepr !== 'volume') return null
    const { points, edges } = volMesh
    const buf = new Float32Array(edges.length * 6)
    let i = 0
    for (const [a, b] of edges) {
      buf[i++] = points[a][0]; buf[i++] = points[a][1]; buf[i++] = points[a][2]
      buf[i++] = points[b][0]; buf[i++] = points[b][1]; buf[i++] = points[b][2]
    }
    return buf
  }, [volMesh, viewRepr])

  const stepGeometry = useMemo(() => {
    if (!stepSurface || stepSurface.triangles.length === 0) return null
    const { points, triangles } = stepSurface
    const positions = new Float32Array(triangles.length * 9)
    const normals = new Float32Array(triangles.length * 9)
    let pi = 0
    for (const [a, b, c] of triangles) {
      const pa = points[a], pb = points[b], pc = points[c]
      positions[pi]     = pa[0]; positions[pi + 1] = pa[1]; positions[pi + 2] = pa[2]
      positions[pi + 3] = pb[0]; positions[pi + 4] = pb[1]; positions[pi + 5] = pb[2]
      positions[pi + 6] = pc[0]; positions[pi + 7] = pc[1]; positions[pi + 8] = pc[2]
      const ax = pb[0] - pa[0], ay = pb[1] - pa[1], az = pb[2] - pa[2]
      const bx = pc[0] - pa[0], by = pc[1] - pa[1], bz = pc[2] - pa[2]
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
      nx /= len; ny /= len; nz /= len
      normals[pi]     = nx; normals[pi + 1] = ny; normals[pi + 2] = nz
      normals[pi + 3] = nx; normals[pi + 4] = ny; normals[pi + 5] = nz
      normals[pi + 6] = nx; normals[pi + 7] = ny; normals[pi + 8] = nz
      pi += 9
    }
    return { positions, normals }
  }, [stepSurface])

  if (nodes.length === 0 && !stepGeometry?.positions) {
    return null
  }

  const showStepSurface = (viewRepr === 'geometry' || nodes.length === 0) && !!stepGeometry
  const showFemEdges = viewRepr === 'surface' || viewRepr === 'wireframe'
  const solidFill = viewRepr !== 'wireframe'

  return (
    <group>
      {/* Undeformed solid surface — light blue-grey on light background */}
      {!result && undeformedSurface && (
        <mesh onClick={pickMode ? handleFacePick : undefined}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[undeformedSurface.positions, 3]} />
            <bufferAttribute attach="attributes-normal" args={[undeformedSurface.normals, 3]} />
          </bufferGeometry>
          <meshStandardMaterial color="#b8cce4" side={THREE.DoubleSide} wireframe={!solidFill} />
        </mesh>
      )}

      {/* Element edges — shown from mesh mode onward for the classic FEM wireframe look */}
      {!result && showFemEdges && undeformedEdgePositions && (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[undeformedEdgePositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color="#2d4a6b" />
        </lineSegments>
      )}

      {/* Bar elements */}
      {barLines.map((pts, i) => (
        <Line key={`b-${i}`} points={pts} color="#1e3a5f" lineWidth={2} />
      ))}

      {/* Deformed solid surface */}
      {deformedSurface && (
        <mesh onClick={pickMode ? handleFacePick : undefined}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[deformedSurface.positions, 3]} />
            <bufferAttribute attach="attributes-color" args={[deformedSurface.colors, 3]} />
          </bufferGeometry>
          <meshStandardMaterial vertexColors side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Deformed wireframe overlay */}
      {deformedEdgePositions && (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[deformedEdgePositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color="#1e3a5f" transparent opacity={0.4} />
        </lineSegments>
      )}

      {/* Selected face highlight — colour overlay on the exact picked triangles */}
      {selectedFacePositions && (
        <mesh renderOrder={1}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[selectedFacePositions, 3]} />
          </bufferGeometry>
          <meshBasicMaterial color="#e05533" transparent opacity={0.55} depthTest={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* BC markers — triangular fixed-support symbols (3-sided cone, apex at face, base outward) */}
      {bcMarkerData && (
        <group position={bcMarkerData.pos} quaternion={bcMarkerData.quaternion}>
          <mesh position={[0, -modelSize * 0.075, 0]}>
            <coneGeometry args={[modelSize * 0.09, modelSize * 0.15, 3]} />
            <meshStandardMaterial color="#dc2626" />
          </mesh>
          {/* Backing strip representing the fixed wall */}
          <mesh position={[0, -modelSize * 0.165, 0]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[modelSize * 0.22, modelSize * 0.03]} />
            <meshStandardMaterial color="#dc2626" side={THREE.DoubleSide} />
          </mesh>
        </group>
      )}

      {/* Load arrow — resultant of all force DOFs, cylinder shaft + cone head */}
      {loadArrowData && (() => {
        const shaftLen = modelSize * 0.22
        const headLen = modelSize * 0.09
        const shaftR = modelSize * 0.012
        const headR = modelSize * 0.038
        return (
          <group position={loadArrowData.pos} quaternion={loadArrowData.quaternion}>
            <mesh position={[0, shaftLen / 2, 0]}>
              <cylinderGeometry args={[shaftR, shaftR, shaftLen, 8]} />
              <meshStandardMaterial color="#d97706" />
            </mesh>
            <mesh position={[0, shaftLen + headLen / 2, 0]}>
              <coneGeometry args={[headR, headLen, 8]} />
              <meshStandardMaterial color="#d97706" />
            </mesh>
          </group>
        )
      })()}

      {/* Volume mesh wireframe */}
      {volMeshPositions && (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[volMeshPositions, 3]} />
          </bufferGeometry>
          <lineBasicMaterial color="#ff8844" />
        </lineSegments>
      )}

      {/* STEP surface mesh — visible in geometry mode only; replaced by FEM mesh in mesh mode */}
      {showStepSurface && stepGeometry && (
        <mesh>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[stepGeometry.positions, 3]} />
            <bufferAttribute attach="attributes-normal" args={[stepGeometry.normals, 3]} />
          </bufferGeometry>
          <meshStandardMaterial
            color="#7a9bbf"
            side={THREE.DoubleSide}
            wireframe={!solidFill}
          />
        </mesh>
      )}
    </group>
  )
}

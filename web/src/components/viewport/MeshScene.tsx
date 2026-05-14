import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { ThreeEvent } from '@react-three/fiber'
import { useModelStore } from '../../store/modelStore'

const TARGET_DEFORM_FRACTION = 0.20

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

function hexEdgePoints(
  nodeIds: number[],
  coordOf: (id: number) => [number, number, number],
): [number, number, number][][] {
  return HEX_EDGES.map(([a, b]) => [coordOf(nodeIds[a]), coordOf(nodeIds[b])])
}

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

function tetEdgePoints(
  nodeIds: number[],
  coordOf: (id: number) => [number, number, number],
): [number, number, number][][] {
  return TET_EDGES.map(([a, b]) => [coordOf(nodeIds[a]), coordOf(nodeIds[b])])
}

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

  const undeformedEdges = useMemo(() => {
    const coord = (id: number): [number, number, number] => {
      const e = nodeMap.get(id)!
      return [e.n.x, e.n.y, e.n.z]
    }
    return [
      ...hexElements.flatMap(el => hexEdgePoints(el.nodeIds, coord)),
      ...tetElements.flatMap(el => tetEdgePoints(el.nodeIds, coord)),
    ]
  }, [hexElements, tetElements, nodeMap])

  const deformedEdges = useMemo(() => {
    if (!result) return null
    const d = result.displacements
    const coord = (id: number): [number, number, number] => {
      const { n, i } = nodeMap.get(id)!
      return [n.x + (d[i * 6] ?? 0) * deformScale, n.y + (d[i * 6 + 1] ?? 0) * deformScale, n.z + (d[i * 6 + 2] ?? 0) * deformScale]
    }
    return [
      ...hexElements.flatMap(el => hexEdgePoints(el.nodeIds, coord)),
      ...tetElements.flatMap(el => tetEdgePoints(el.nodeIds, coord)),
    ]
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
    nodes.forEach((_, i) => { const uy = d[i * 6 + 1] ?? 0; if (uy < minUy) minUy = uy; if (uy > maxUy) maxUy = uy })
    const range = maxUy - minUy || 1

    const deformedPos = (id: number): [number, number, number] => {
      const { n, i } = nodeMap.get(id)!
      return [n.x + (d[i * 6] ?? 0) * deformScale, n.y + (d[i * 6 + 1] ?? 0) * deformScale, n.z + (d[i * 6 + 2] ?? 0) * deformScale]
    }
    const nodeColor = (id: number): [number, number, number] => {
      const { i } = nodeMap.get(id)!
      const t = ((d[i * 6 + 1] ?? 0) - minUy) / range
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

  // Selected face highlight box
  const faceHighlight = useMemo(() => {
    if (!selectedFace || nodes.length === 0) return null
    const nodeIdSet = new Set(selectedFace.nodeIds)
    const faceNodes = nodes.filter(n => nodeIdSet.has(n.id))
    if (faceNodes.length === 0) return null
    const xs = faceNodes.map(n => n.x), ys = faceNodes.map(n => n.y), zs = faceNodes.map(n => n.z)
    const minX = Math.min(...xs), maxX = Math.max(...xs)
    const minY = Math.min(...ys), maxY = Math.max(...ys)
    const minZ = Math.min(...zs), maxZ = Math.max(...zs)
    return {
      cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, cz: (minZ + maxZ) / 2,
      sx: Math.max(maxX - minX, 1e-4), sy: Math.max(maxY - minY, 1e-4), sz: Math.max(maxZ - minZ, 1e-4),
    }
  }, [selectedFace, nodes])

  // Face picking handler — works for both tri and quad surface meshes
  function handleFacePick(e: ThreeEvent<PointerEvent>) {
    if (!pickMode || !e.face) return
    e.stopPropagation()
    const normal = e.face.normal
    const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z)
    let axis: 'X' | 'Y' | 'Z'
    let isMax: boolean
    if (ax >= ay && ax >= az) { axis = 'X'; isMax = normal.x > 0 }
    else if (ay >= ax && ay >= az) { axis = 'Y'; isMax = normal.y > 0 }
    else { axis = 'Z'; isMax = normal.z > 0 }

    const coords = nodes.map(n => axis === 'X' ? n.x : axis === 'Y' ? n.y : n.z)
    const extremeVal = isMax ? Math.max(...coords) : Math.min(...coords)
    const tol = modelSize * 0.01
    const faceNodeIds = nodes
      .filter(n => Math.abs((axis === 'X' ? n.x : axis === 'Y' ? n.y : n.z) - extremeVal) < tol)
      .map(n => n.id)

    setSelectedFace({
      nodeIds: faceNodeIds,
      label: `${isMax ? 'Max' : 'Min'} ${axis} face (${faceNodeIds.length} nodes)`,
      axis,
      isMax,
    })
  }

  const fixedMarkerPos = useMemo((): [number, number, number] | null => {
    if (constraints.length === 0) return null
    const ids = new Set(constraints.map(c => c.nodeId))
    let x = 0, y = 0, z = 0
    for (const id of ids) { const e = nodeMap.get(id); if (e) { x += e.n.x; y += e.n.y; z += e.n.z } }
    const n = ids.size
    return n > 0 ? [x / n, y / n, z / n] : null
  }, [constraints, nodeMap])

  const loadMarkerPos = useMemo((): [number, number, number] | null => {
    if (loads.length === 0) return null
    const ids = new Set(loads.map(l => l.nodeId))
    let x = 0, y = 0, z = 0
    for (const id of ids) { const e = nodeMap.get(id); if (e) { x += e.n.x; y += e.n.y; z += e.n.z } }
    const n = ids.size
    return n > 0 ? [x / n, y / n, z / n] : null
  }, [loads, nodeMap])

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
    return (
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#4a4a80" wireframe />
      </mesh>
    )
  }

  return (
    <group>
      {/* Undeformed wireframe — only when no result */}
      {!result && undeformedEdges.map((pts, i) => (
        <Line key={`u-${i}`} points={pts} color="#4a4a80" lineWidth={1} />
      ))}

      {/* Bar elements */}
      {barLines.map((pts, i) => (
        <Line key={`b-${i}`} points={pts} color="#5a5a8a" lineWidth={2} />
      ))}

      {/* Clickable undeformed surface (pick mode, no result yet) */}
      {!result && undeformedSurface && pickMode && (
        <mesh onPointerDown={handleFacePick}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[undeformedSurface.positions, 3]} />
            <bufferAttribute attach="attributes-normal" args={[undeformedSurface.normals, 3]} />
          </bufferGeometry>
          <meshStandardMaterial color="#3a3a70" transparent opacity={0.01} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Deformed solid surface */}
      {deformedSurface && (
        <mesh onPointerDown={pickMode ? handleFacePick : undefined}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[deformedSurface.positions, 3]} />
            <bufferAttribute attach="attributes-color" args={[deformedSurface.colors, 3]} />
          </bufferGeometry>
          <meshStandardMaterial vertexColors side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Deformed wireframe overlay */}
      {deformedEdges && deformedEdges.map((pts, i) => (
        <Line key={`d-${i}`} points={pts} color="#ffffff" lineWidth={0.5} opacity={0.3} transparent />
      ))}

      {/* Selected face highlight */}
      {faceHighlight && (
        <mesh position={[faceHighlight.cx, faceHighlight.cy, faceHighlight.cz]}>
          <boxGeometry args={[faceHighlight.sx + 0.002, faceHighlight.sy + 0.002, faceHighlight.sz + 0.002]} />
          <meshStandardMaterial color="#ffcc44" transparent opacity={0.35} depthTest={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Fixed-face marker */}
      {fixedMarkerPos && (
        <mesh position={fixedMarkerPos}>
          <sphereGeometry args={[modelSize * 0.015, 16, 16]} />
          <meshStandardMaterial color="#ff4444" />
        </mesh>
      )}

      {/* Load marker */}
      {loadMarkerPos && (
        <mesh position={loadMarkerPos}>
          <sphereGeometry args={[modelSize * 0.015, 16, 16]} />
          <meshStandardMaterial color="#ffcc00" />
        </mesh>
      )}

      {/* STEP surface mesh — grey shaded */}
      {stepGeometry && (
        <mesh>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[stepGeometry.positions, 3]} />
            <bufferAttribute attach="attributes-normal" args={[stepGeometry.normals, 3]} />
          </bufferGeometry>
          <meshStandardMaterial color="#8899bb" side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  )
}

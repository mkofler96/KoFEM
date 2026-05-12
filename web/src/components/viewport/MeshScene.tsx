import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useModelStore } from '../../store/modelStore'

const TARGET_DEFORM_FRACTION = 0.20  // max visible displacement = 20% of model size

// CHEXA8 local edge pairs (indices into 8-node connectivity)
const HEX_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 0], // bottom face
  [4, 5], [5, 6], [6, 7], [7, 4], // top face
  [0, 4], [1, 5], [2, 6], [3, 7], // verticals
]

// CHEXA8 face definitions — local node index quads
const HEX_FACE_DEFS: [number, number, number, number][] = [
  [0, 1, 2, 3], // bottom (ζ=-1)
  [4, 5, 6, 7], // top (ζ=+1)
  [0, 1, 5, 4], // front (η=-1)
  [2, 3, 7, 6], // back (η=+1)
  [0, 3, 7, 4], // left (ξ=-1)
  [1, 2, 6, 5], // right (ξ=+1)
]

function hexEdgePoints(
  nodeIds: number[],
  coordOf: (id: number) => [number, number, number],
): [number, number, number][][] {
  return HEX_EDGES.map(([a, b]) => [coordOf(nodeIds[a]), coordOf(nodeIds[b])])
}

// Returns face node-ID quads that appear in exactly one element (boundary faces).
// Shared internal faces between adjacent elements are excluded.
function extractBoundaryFaceIds(
  hexElems: { nodeIds: number[] }[],
): [number, number, number, number][] {
  const faceMap = new Map<string, { face: [number, number, number, number]; count: number }>()
  for (const el of hexElems) {
    for (const [a, b, c, d] of HEX_FACE_DEFS) {
      const face: [number, number, number, number] = [
        el.nodeIds[a], el.nodeIds[b], el.nodeIds[c], el.nodeIds[d],
      ]
      const key = [...face].sort((x, y) => x - y).join(',')
      const entry = faceMap.get(key)
      if (entry) {
        entry.count++
      } else {
        faceMap.set(key, { face, count: 1 })
      }
    }
  }
  return [...faceMap.values()].filter(e => e.count === 1).map(e => e.face)
}

export function MeshScene() {
  const nodes = useModelStore(s => s.nodes)
  const elements = useModelStore(s => s.elements)
  const constraints = useModelStore(s => s.constraints)
  const loads = useModelStore(s => s.loads)
  const result = useModelStore(s => s.result)

  const nodeMap = useMemo(
    () => new Map(nodes.map((n, i) => [n.id, { n, i }])),
    [nodes],
  )

  // Model bounding-box longest dimension
  const modelSize = useMemo(() => {
    if (nodes.length === 0) return 1
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity
    for (const n of nodes) {
      if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x
      if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y
      if (n.z < minZ) minZ = n.z; if (n.z > maxZ) maxZ = n.z
    }
    return Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-9)
  }, [nodes])

  // Auto scale: max(|u|) * scale ≈ TARGET_DEFORM_FRACTION * modelSize
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

  // CHEXA only — CTETRA/CPENTA have different connectivity and need separate handling
  const hexElements = useMemo(
    () => elements.filter(e => e.type === 'CHEXA'),
    [elements],
  )
  const barElements = useMemo(
    () => elements.filter(e => e.type === 'CBAR' || e.type === 'CBEAM'),
    [elements],
  )

  // Boundary face node-ID quads (internal shared faces excluded)
  const boundaryFaceIds = useMemo(
    () => extractBoundaryFaceIds(hexElements),
    [hexElements],
  )

  // Undeformed hex edges
  const undeformedEdges = useMemo(() => {
    if (hexElements.length === 0) return []
    const coord = (id: number): [number, number, number] => {
      const e = nodeMap.get(id)!
      return [e.n.x, e.n.y, e.n.z]
    }
    return hexElements.flatMap(el => hexEdgePoints(el.nodeIds, coord))
  }, [hexElements, nodeMap])

  // Deformed hex edges
  const deformedEdges = useMemo(() => {
    if (!result || hexElements.length === 0) return null
    const d = result.displacements
    const coord = (id: number): [number, number, number] => {
      const { n, i } = nodeMap.get(id)!
      return [
        n.x + (d[i * 6 + 0] ?? 0) * deformScale,
        n.y + (d[i * 6 + 1] ?? 0) * deformScale,
        n.z + (d[i * 6 + 2] ?? 0) * deformScale,
      ]
    }
    return hexElements.flatMap(el => hexEdgePoints(el.nodeIds, coord))
  }, [result, hexElements, nodeMap, deformScale])

  // Bar element lines (undeformed)
  const barLines = useMemo(() => {
    return barElements.map(el =>
      el.nodeIds.map(id => {
        const e = nodeMap.get(id)!
        return [e.n.x, e.n.y, e.n.z] as [number, number, number]
      }),
    )
  }, [barElements, nodeMap])

  // Deformed solid surface — boundary faces only, coloured by Uy magnitude
  const deformedSurface = useMemo(() => {
    if (!result || boundaryFaceIds.length === 0) return null
    const d = result.displacements
    const positions: number[] = []
    const colors: number[] = []

    // Find Uy range for colour mapping
    let minUy = Infinity, maxUy = -Infinity
    nodes.forEach((_, i) => {
      const uy = d[i * 6 + 1] ?? 0
      if (uy < minUy) minUy = uy
      if (uy > maxUy) maxUy = uy
    })
    const range = maxUy - minUy || 1

    const deformedPos = (id: number): [number, number, number] => {
      const { n, i } = nodeMap.get(id)!
      return [
        n.x + (d[i * 6 + 0] ?? 0) * deformScale,
        n.y + (d[i * 6 + 1] ?? 0) * deformScale,
        n.z + (d[i * 6 + 2] ?? 0) * deformScale,
      ]
    }
    const nodeColor = (id: number): [number, number, number] => {
      const { i } = nodeMap.get(id)!
      const t = ((d[i * 6 + 1] ?? 0) - minUy) / range   // 0→1
      // blue → cyan → green → yellow → red
      const c = new THREE.Color()
      c.setHSL(0.667 * (1 - t), 1, 0.5)
      return [c.r, c.g, c.b]
    }

    for (const [a, b, c_, dd] of boundaryFaceIds) {
      const pa = deformedPos(a), pb = deformedPos(b)
      const pc = deformedPos(c_), pd = deformedPos(dd)
      const ca = nodeColor(a), cb = nodeColor(b)
      const cc = nodeColor(c_), cd = nodeColor(dd)
      // Triangle 1: a-b-c
      positions.push(...pa, ...pb, ...pc)
      colors.push(...ca, ...cb, ...cc)
      // Triangle 2: a-c-d
      positions.push(...pa, ...pc, ...pd)
      colors.push(...ca, ...cc, ...cd)
    }

    return { positions: new Float32Array(positions), colors: new Float32Array(colors) }
  }, [result, boundaryFaceIds, nodeMap, nodes, deformScale])

  // Centroid of constrained nodes — fixed-face marker position
  const fixedMarkerPos = useMemo((): [number, number, number] | null => {
    if (constraints.length === 0) return null
    const ids = new Set(constraints.map(c => c.nodeId))
    let x = 0, y = 0, z = 0
    for (const id of ids) {
      const e = nodeMap.get(id)
      if (e) { x += e.n.x; y += e.n.y; z += e.n.z }
    }
    const n = ids.size
    return n > 0 ? [x / n, y / n, z / n] : null
  }, [constraints, nodeMap])

  // Centroid of loaded nodes — load marker position
  const loadMarkerPos = useMemo((): [number, number, number] | null => {
    if (loads.length === 0) return null
    const ids = new Set(loads.map(l => l.nodeId))
    let x = 0, y = 0, z = 0
    for (const id of ids) {
      const e = nodeMap.get(id)
      if (e) { x += e.n.x; y += e.n.y; z += e.n.z }
    }
    const n = ids.size
    return n > 0 ? [x / n, y / n, z / n] : null
  }, [loads, nodeMap])

  if (nodes.length === 0) {
    return (
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#4a4a80" wireframe />
      </mesh>
    )
  }

  return (
    <group>
      {/* Undeformed wireframe — dim grey, only shown when no result */}
      {!result && undeformedEdges.map((pts, i) => (
        <Line key={`u-${i}`} points={pts} color="#4a4a80" lineWidth={1} />
      ))}

      {/* Bar elements */}
      {barLines.map((pts, i) => (
        <Line key={`b-${i}`} points={pts} color="#5a5a8a" lineWidth={2} />
      ))}

      {/* Deformed solid surface with colour map */}
      {deformedSurface && (
        <mesh>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[deformedSurface.positions, 3]}
            />
            <bufferAttribute
              attach="attributes-color"
              args={[deformedSurface.colors, 3]}
            />
          </bufferGeometry>
          <meshStandardMaterial vertexColors side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Deformed wireframe overlay */}
      {deformedEdges && deformedEdges.map((pts, i) => (
        <Line key={`d-${i}`} points={pts} color="#ffffff" lineWidth={0.5} opacity={0.3} transparent />
      ))}

      {/* Fixed-face marker — red sphere at centroid of constrained nodes */}
      {fixedMarkerPos && (
        <mesh position={fixedMarkerPos}>
          <sphereGeometry args={[0.015, 16, 16]} />
          <meshStandardMaterial color="#ff4444" />
        </mesh>
      )}

      {/* Load marker — yellow sphere at centroid of loaded nodes */}
      {loadMarkerPos && (
        <mesh position={loadMarkerPos}>
          <sphereGeometry args={[0.015, 16, 16]} />
          <meshStandardMaterial color="#ffcc00" />
        </mesh>
      )}
    </group>
  )
}

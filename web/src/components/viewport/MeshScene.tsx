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

function hexEdgePoints(
  nodeIds: number[],
  coordOf: (id: number) => [number, number, number],
): [number, number, number][][] {
  return HEX_EDGES.map(([a, b]) => [coordOf(nodeIds[a]), coordOf(nodeIds[b])])
}

export function MeshScene() {
  const nodes = useModelStore(s => s.nodes)
  const elements = useModelStore(s => s.elements)
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

  const hexElements = useMemo(
    () => elements.filter(e => e.type === 'CHEXA' || e.type === 'CTETRA' || e.type === 'CPENTA'),
    [elements],
  )
  const barElements = useMemo(
    () => elements.filter(e => e.type === 'CBAR' || e.type === 'CBEAM'),
    [elements],
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
  }, [result, hexElements, nodeMap])

  // Bar element lines (undeformed)
  const barLines = useMemo(() => {
    return barElements.map(el =>
      el.nodeIds.map(id => {
        const e = nodeMap.get(id)!
        return [e.n.x, e.n.y, e.n.z] as [number, number, number]
      }),
    )
  }, [barElements, nodeMap])

  // Deformed solid surface — coloured by Uy magnitude
  const deformedSurface = useMemo(() => {
    if (!result || hexElements.length === 0) return null
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

    // Each hex face as 2 triangles
    const HEX_FACES: [number, number, number, number][] = [
      [0, 1, 2, 3], // bottom (ζ=-1)
      [4, 5, 6, 7], // top (ζ=+1)
      [0, 1, 5, 4], // front (η=-1)
      [2, 3, 7, 6], // back (η=+1)
      [0, 3, 7, 4], // left (ξ=-1)
      [1, 2, 6, 5], // right (ξ=+1)
    ]

    for (const el of hexElements) {
      for (const [a, b, c_, dd] of HEX_FACES) {
        const nids = el.nodeIds
        const pa = deformedPos(nids[a])
        const pb = deformedPos(nids[b])
        const pc = deformedPos(nids[c_])
        const pd = deformedPos(nids[dd])
        const ca = nodeColor(nids[a])
        const cb = nodeColor(nids[b])
        const cc = nodeColor(nids[c_])
        const cd = nodeColor(nids[dd])
        // Triangle 1: a-b-c
        positions.push(...pa, ...pb, ...pc)
        colors.push(...ca, ...cb, ...cc)
        // Triangle 2: a-c-d
        positions.push(...pa, ...pc, ...pd)
        colors.push(...ca, ...cc, ...cd)
      }
    }

    return { positions: new Float32Array(positions), colors: new Float32Array(colors) }
  }, [result, hexElements, nodeMap, nodes])

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

      {/* Fixed-face marker — red sphere at origin */}
      <mesh position={[0, 0.05, 0.05]}>
        <sphereGeometry args={[0.015, 16, 16]} />
        <meshStandardMaterial color="#ff4444" />
      </mesh>

      {/* Load marker — yellow sphere at tip centroid */}
      <mesh position={[1.0, 0.05, 0.05]}>
        <sphereGeometry args={[0.015, 16, 16]} />
        <meshStandardMaterial color="#ffcc00" />
      </mesh>
    </group>
  )
}

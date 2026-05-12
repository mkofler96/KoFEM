import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import { useModelStore } from '../../store/modelStore'

// Scale factor for visualizing displacements (auto-scaled to beam length)
const DEFORM_SCALE = 500

export function MeshScene() {
  const nodes = useModelStore(s => s.nodes)
  const elements = useModelStore(s => s.elements)
  const result = useModelStore(s => s.result)

  // Undeformed beam — collect line segments from CBAR/CBEAM elements
  const undeformedLines = useMemo(() => {
    const nodeMap = new Map(nodes.map(n => [n.id, n]))
    return elements
      .filter(e => e.type === 'CBAR' || e.type === 'CBEAM')
      .map(e => {
        const pts = e.nodeIds.map(id => {
          const n = nodeMap.get(id)!
          return [n.x, n.y, n.z] as [number, number, number]
        })
        return pts
      })
  }, [nodes, elements])

  // Deformed shape — same topology but with displacements added
  const deformedLines = useMemo(() => {
    if (!result) return null
    const d = result.displacements
    const nodeMap = new Map(nodes.map((n, i) => [n.id, { n, i }]))
    return elements
      .filter(e => e.type === 'CBAR' || e.type === 'CBEAM')
      .map(e => {
        const pts = e.nodeIds.map(id => {
          const entry = nodeMap.get(id)!
          const base = entry.i * 6
          return [
            entry.n.x + (d[base + 0] ?? 0) * DEFORM_SCALE,
            entry.n.y + (d[base + 1] ?? 0) * DEFORM_SCALE,
            entry.n.z + (d[base + 2] ?? 0) * DEFORM_SCALE,
          ] as [number, number, number]
        })
        return pts
      })
  }, [nodes, elements, result])

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
      {/* Undeformed geometry — grey */}
      {undeformedLines.map((pts, i) => (
        <Line key={`u-${i}`} points={pts} color="#5a5a8a" lineWidth={1.5} />
      ))}

      {/* Deformed geometry — cyan */}
      {deformedLines &&
        deformedLines.map((pts, i) => (
          <Line key={`d-${i}`} points={pts} color="#00e5ff" lineWidth={2.5} />
        ))}

      {/* Fixed support marker — red sphere at node 0 */}
      {nodes[0] && (
        <mesh position={[nodes[0].x, nodes[0].y, nodes[0].z]}>
          <sphereGeometry args={[0.02, 16, 16]} />
          <meshStandardMaterial color="#ff4444" />
        </mesh>
      )}

      {/* Load marker — yellow sphere at tip */}
      {nodes[nodes.length - 1] && (
        <mesh position={[nodes[nodes.length - 1].x, nodes[nodes.length - 1].y, nodes[nodes.length - 1].z]}>
          <sphereGeometry args={[0.02, 16, 16]} />
          <meshStandardMaterial color="#ffcc00" />
        </mesh>
      )}
    </group>
  )
}

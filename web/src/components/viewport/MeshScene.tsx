import React from 'react'
import { useModelStore } from '../../store/modelStore'

export function MeshScene() {
  const elements = useModelStore(s => s.elements)
  const nodes = useModelStore(s => s.nodes)

  // TODO: render actual mesh geometry from nodes/elements
  // For now render a placeholder cube
  if (nodes.length === 0) {
    return (
      <mesh>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#4a4a80" wireframe />
      </mesh>
    )
  }

  return null
}

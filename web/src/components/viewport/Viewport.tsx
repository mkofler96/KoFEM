import { Canvas } from '@react-three/fiber'
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from '@react-three/drei'
import { MeshScene } from './MeshScene'
import { FitCamera } from './FitCamera'
import { useModelStore } from '../../store/modelStore'

export function Viewport() {
  const pickMode = useModelStore(s => s.pickMode)

  return (
    <Canvas
      camera={{ position: [5, 5, 5], fov: 45 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      style={{ background: '#12121f', cursor: pickMode ? 'crosshair' : 'default' }}
    >
      <ambientLight intensity={0.4} />
      <directionalLight position={[10, 10, 10]} intensity={1} castShadow />
      <MeshScene />
      <Grid
        infiniteGrid
        cellSize={0.5}
        sectionSize={2}
        fadeDistance={50}
        cellColor="#2d2d52"
        sectionColor="#4a4a80"
      />
      <OrbitControls makeDefault enabled={!pickMode} />
      <FitCamera />
      <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
        <GizmoViewport labelColor="white" axisHeadScale={1} />
      </GizmoHelper>
    </Canvas>
  )
}

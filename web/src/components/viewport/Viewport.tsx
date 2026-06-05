import { Canvas } from '@react-three/fiber'
import { OrbitControls, Grid, GizmoHelper, GizmoViewport } from '@react-three/drei'
import { MeshScene } from './MeshScene'
import { FitCamera } from './FitCamera'
import { useModelStore } from '../../store/modelStore'

export function Viewport() {
  const pickMode       = useModelStore(s => s.pickMode)
  const triggerFitView = useModelStore(s => s.triggerFitView)

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Top-right HUD */}
      <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 10 }}>
        <button
          style={{
            padding: '4px 10px',
            background: 'rgba(255,255,255,0.85)',
            border: '1px solid #d1d5db',
            borderRadius: 5,
            fontSize: 12,
            color: '#374151',
            cursor: 'pointer',
            backdropFilter: 'blur(4px)',
            fontFamily: 'inherit',
          }}
          onClick={triggerFitView}
        >
          Fit View
        </button>
      </div>

      <Canvas
        camera={{ position: [5, 5, 5], fov: 45 }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        style={{ background: '#f0f2f5', cursor: pickMode ? 'crosshair' : 'default' }}
      >
        <ambientLight intensity={0.7} />
        <directionalLight position={[8, 10, 8]} intensity={0.9} castShadow />
        <directionalLight position={[-5, 5, -5]} intensity={0.3} />
        <MeshScene />
        <Grid
          infiniteGrid
          cellSize={0.5}
          sectionSize={2}
          fadeDistance={50}
          cellColor="#d1d5db"
          sectionColor="#9ca3af"
        />
        <OrbitControls makeDefault enabled={!pickMode} />
        <FitCamera />
        <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
          <GizmoViewport labelColor="#374151" axisHeadScale={1} />
        </GizmoHelper>
      </Canvas>
    </div>
  )
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Canvas } from "@react-three/fiber";
import { OrbitControls, GizmoHelper, GizmoViewport } from "@react-three/drei";
import { MeshScene } from "./MeshScene";
import { OrbitPivot } from "./OrbitPivot";
import { ReportCapture } from "./ReportCapture";
import { ViewportTestHooks } from "./ViewportTestHooks";
import { ProjectionSwitch } from "./ProjectionSwitch";
import { pickingEvents } from "./pickingEvents";
import { ColorBar } from "./ColorBar";
import { DensityColorBar } from "./DensityColorBar";
import { EmptyState } from "./EmptyState";
import { RefinementChart } from "./RefinementChart";
import { TopOptChart } from "./TopOptChart";
import { SampleGuide } from "./SampleGuide";
import { useModelStore } from "../../store/modelStore";
import { useFemModule } from "../../hooks/useFemModule";
import { VIEW_FOV } from "../../lib/projection";
import { useT } from "../../i18n/useLocale";
import { viewportMessages } from "../../i18n/messages/viewport";

// The mesh is drawn from what the Rust module finds of it; if the module
// cannot load, say so instead of showing an empty viewport.
function FemModuleNotice() {
  const { error } = useFemModule();
  const text = useT(viewportMessages);
  if (error === null) return null;
  return (
    <div
      role="alert"
      style={{
        position: "absolute",
        top: 10,
        left: 10,
        right: 90,
        zIndex: 10,
        padding: "6px 10px",
        background: "#fef2f2",
        border: "1px solid #fecaca",
        borderRadius: 5,
        fontSize: 12,
        color: "#991b1b",
      }}
    >
      {text.meshCannotDraw(error)}
    </div>
  );
}

export function Viewport() {
  const pickMode = useModelStore((s) => s.pickMode);
  const splitPicking = useModelStore((s) => s.splitPicking);
  const triggerFitView = useModelStore((s) => s.triggerFitView);
  const text = useT(viewportMessages);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {/* Top-right HUD */}
      <div style={{ position: "absolute", top: 10, right: 10, zIndex: 10 }}>
        <button
          style={{
            padding: "4px 10px",
            background: "rgba(255,255,255,0.85)",
            border: "1px solid #d1d5db",
            borderRadius: 5,
            fontSize: 12,
            color: "#374151",
            cursor: "pointer",
            backdropFilter: "blur(4px)",
            fontFamily: "inherit",
          }}
          onClick={triggerFitView}
        >
          {text.fitView}
        </button>
      </div>

      <FemModuleNotice />

      {/* Result field legend — static field, or density for a TO run */}
      <ColorBar />
      <DensityColorBar />

      {/* Results → Mesh refinement: the convergence chart in place of 3D.
          The canvas stays mounted underneath, so opening a level is instant. */}
      <RefinementChart />
      {/* Results → Density on its chart: the optimization's convergence. */}
      <TopOptChart />

      {/* Nothing loaded yet: the sample entry; then the sample's guide */}
      <EmptyState />
      <SampleGuide />

      {/* Render on demand, not every frame: nothing in the scene animates on
          its own. R3F redraws on prop changes, OrbitControls and the gizmo
          ask for frames themselves, and code that moves the camera directly
          calls invalidate(). Continuous rendering kept a CPU core busy.
          Picking refreshes the world matrices itself (pickingEvents), since
          a click can come before the next frame. */}
      <Canvas
        frameloop="demand"
        events={pickingEvents}
        camera={{ position: [5, 5, 5], fov: VIEW_FOV }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        // Materials clip at the result section plane (KOF-390).
        onCreated={({ gl }) => {
          gl.localClippingEnabled = true;
        }}
        style={{
          background: "#f0f2f5",
          cursor: pickMode || splitPicking ? "crosshair" : "default",
        }}
      >
        <ambientLight intensity={0.7} />
        <directionalLight position={[8, 10, 8]} intensity={0.9} castShadow />
        <directionalLight position={[-5, 5, -5]} intensity={0.3} />
        <MeshScene />
        {/* Rotation is OrbitPivot's: about the point under the cursor. */}
        <OrbitControls makeDefault enableRotate={false} zoomToCursor />
        <OrbitPivot />
        <ProjectionSwitch />
        <ViewportTestHooks />
        <ReportCapture />
        <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
          <GizmoViewport labelColor="#374151" axisHeadScale={1} />
        </GizmoHelper>
      </Canvas>
    </div>
  );
}

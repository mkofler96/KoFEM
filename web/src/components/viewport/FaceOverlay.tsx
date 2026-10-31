// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The translucent face overlay every BC, load, tie, coupling and pick-session
// highlight is drawn with.

import { DoubleSide } from "three";

interface FaceOverlayProps {
  positions: Float32Array;
  color: string;
  opacity: number;
  renderOrder: number;
}

// A translucent, always-on-top overlay of boundary triangles (positions from
// buildFacePositions), drawn double-sided so it reads from either side.
export function FaceOverlay({
  positions,
  color,
  opacity,
  renderOrder,
}: FaceOverlayProps) {
  return (
    <mesh renderOrder={renderOrder}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <meshBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        depthTest={false}
        side={DoubleSide}
      />
    </mesh>
  );
}

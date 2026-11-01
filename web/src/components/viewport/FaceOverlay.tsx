// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// JS-0455 checks DOM attributes; these are Three.js objects whose properties
// are checked by React Three Fiber's TypeScript types. Annotate only those props.

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
    <mesh
      // skipcq: JS-0455 -- typed React Three Fiber property
      renderOrder={renderOrder}
    >
      <bufferGeometry>
        <bufferAttribute
          // skipcq: JS-0455 -- typed React Three Fiber property
          attach="attributes-position"
          // skipcq: JS-0455 -- typed React Three Fiber property
          args={[positions, 3]}
        />
      </bufferGeometry>
      <meshBasicMaterial
        color={color}

        // skipcq: JS-0455 -- typed React Three Fiber property
        transparent
        opacity={opacity}

        // skipcq: JS-0455 -- typed React Three Fiber property
        depthTest={false}

        // skipcq: JS-0455 -- typed React Three Fiber property
        side={DoubleSide}
      />
    </mesh>
  );
}

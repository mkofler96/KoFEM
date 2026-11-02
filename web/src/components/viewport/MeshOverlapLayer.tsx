// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// JS-0455 checks DOM attributes; these are Three.js objects whose properties
// are checked by React Three Fiber's TypeScript types. Annotate only those props.

// Where the last mesh attempt found the surface overlapping itself: the elements
// involved, plus the exact contact line of a hinge. Always on top, because a
// hinge usually sits in a narrow slot the model hides.

import { useMemo } from "react";
import { useModelStore } from "../../store/modelStore";
import { FaceOverlay } from "./FaceOverlay";

const OVERLAP_COLOR = "#dc2626";

export function MeshOverlapLayer() {
  const overlaps = useModelStore((s) => s.meshOverlaps);
  const shapes = useMemo(
    () =>
      overlaps.map((overlap) => ({
        faces: Float32Array.from(overlap.positions),
        line: overlap.hinge
          ? new Float32Array([...overlap.hinge.start, ...overlap.hinge.end])
          : null,
      })),
    [overlaps],
  );

  return (
    <group>
      {shapes.map(({ faces, line }, i) => (
        <group key={i}>
          <FaceOverlay
            positions={faces}
            color={OVERLAP_COLOR}
            opacity={0.45}
            renderOrder={10}
          />
          {line && (
            <lineSegments
              // skipcq: JS-0455 -- typed React Three Fiber property
              renderOrder={11}
            >
              <bufferGeometry>
                <bufferAttribute
                  // skipcq: JS-0455 -- typed React Three Fiber property
                  attach="attributes-position"
                  // skipcq: JS-0455 -- typed React Three Fiber property
                  args={[line, 3]}
                />
              </bufferGeometry>
              <lineBasicMaterial
                color={OVERLAP_COLOR}
                // skipcq: JS-0455 -- typed React Three Fiber property
                depthTest={false}
              />
            </lineSegments>
          )}
        </group>
      ))}
    </group>
  );
}

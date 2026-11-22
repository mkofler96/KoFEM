// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// JS-0455 checks DOM attributes; these are Three.js objects whose properties
// are checked by React Three Fiber's TypeScript types. Annotate only those props.

// Results → Reactions in the view (KOF-387): an arrow per support, or per held
// node, ending where the support pushes on the model. Drawn at the undeformed
// position, where a support's nodes stay.

import { useMemo } from "react";
import { Quaternion, Vector3 } from "three";
import { useModelStore } from "../../store/modelStore";
import {
  rangeFraction,
  reactionArrows,
  reactionRange,
} from "../../lib/reactionArrows";
import { resultColor } from "../../lib/resultField";

const UP = new Vector3(0, 1, 0);

export function ReactionArrows({ modelSize }: { modelSize: number }) {
  const reactions = useModelStore((s) =>
    s.showReactions ? (s.result?.reactions ?? null) : null,
  );
  const display = useModelStore((s) => s.reactionsDisplay);
  // Each arrow coloured on the legend's scale, the range of what is drawn.
  const arrows = useMemo(() => {
    if (!reactions) return [];
    const range = reactionRange(reactions, display);
    if (!range) return [];
    return reactionArrows(reactions, display).map((arrow) => ({
      ...arrow,
      quaternion: new Quaternion().setFromUnitVectors(
        UP,
        new Vector3(...arrow.direction),
      ),
      color: resultColor(rangeFraction(arrow.magnitude, range)),
    }));
  }, [reactions, display]);
  const nodal = display === "nodal";
  return (
    <>
      {arrows.map((arrow) => {
        // Short nodal arrows keep 35% of the full length so they stay visible.
        const full = modelSize * (nodal ? 0.13 : 0.24);
        const len = nodal ? full * (0.35 + 0.65 * arrow.size) : full;
        const headLen = len * (nodal ? 0.32 : 0.3);
        const shaftLen = len - headLen;
        const shaftR = modelSize * (nodal ? 0.006 : 0.012);
        const headR = modelSize * (nodal ? 0.018 : 0.038);
        // The group's origin is the tail; the head ends at the tip.
        const tail: [number, number, number] = [
          arrow.tip[0] - arrow.direction[0] * len,
          arrow.tip[1] - arrow.direction[1] * len,
          arrow.tip[2] - arrow.direction[2] * len,
        ];
        return (
          <group
            key={arrow.key}
            // skipcq: JS-0455 -- typed React Three Fiber property
            position={tail}
            // skipcq: JS-0455 -- typed React Three Fiber property
            quaternion={arrow.quaternion}
          >
            <mesh
              // skipcq: JS-0455 -- typed React Three Fiber property
              position={[0, shaftLen / 2, 0]}
            >
              <cylinderGeometry
                // skipcq: JS-0455 -- typed React Three Fiber property
                args={[shaftR, shaftR, shaftLen, 8]}
              />
              <meshStandardMaterial color={arrow.color} />
            </mesh>
            <mesh
              // skipcq: JS-0455 -- typed React Three Fiber property
              position={[0, shaftLen + headLen / 2, 0]}
            >
              <coneGeometry
                // skipcq: JS-0455 -- typed React Three Fiber property
                args={[headR, headLen, 8]}
              />
              <meshStandardMaterial color={arrow.color} />
            </mesh>
          </group>
        );
      })}
    </>
  );
}

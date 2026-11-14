// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// JS-0455 checks DOM attributes; these are Three.js objects whose properties
// are checked by React Three Fiber's TypeScript types. Annotate only those props.

// The translucent line an edge selection is drawn with — the counterpart of
// FaceOverlay for a picked rim polyline, whose node set spans no triangle and
// so leaves FaceOverlay nothing to fill (KOF-356).

import { Line } from "@react-three/drei";
import type { Vec3 } from "../../lib/facePick";

// Screen-space width, in pixels: a 1 px GL line is lost against the mesh
// wireframe, and a pixel width reads the same at every zoom.
const EDGE_LINE_WIDTH = 5;

interface EdgeOverlayProps {
  // Segment endpoints in pairs (buildEdgePositions).
  points: Vec3[];
  color: string;
  opacity: number;
  renderOrder: number;
  // Names the object for the viewport test hooks (drawnSegments).
  name: string;
}

// An always-on-top, translucent polyline of boundary edges.
export function EdgeOverlay({
  points,
  color,
  opacity,
  renderOrder,
  name,
}: EdgeOverlayProps) {
  return (
    <Line
      points={points}
      segments
      color={color}
      lineWidth={EDGE_LINE_WIDTH}
      // skipcq: JS-0455 -- typed React Three Fiber property
      transparent
      opacity={opacity}
      // skipcq: JS-0455 -- typed React Three Fiber property
      depthTest={false}
      // skipcq: JS-0455 -- typed React Three Fiber property
      renderOrder={renderOrder}
      name={name}
      // skipcq: JS-0455 -- typed React Three Fiber property
      userData={{ segments: points.length / 2 }}
    />
  );
}

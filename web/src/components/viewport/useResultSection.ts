// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The section plane as drawn (KOF-390): the store's axis, position and flip,
// placed on the model at its deformation scale, with the clipping plane that
// hides the removed part. Null when no section is set or no result is shown.

import { useMemo } from "react";
import type * as THREE from "three";
import { useModelStore } from "../../store/modelStore";
import {
  deformedPoints,
  sectionClipPlane,
  sectionLevel,
} from "../../lib/sectionCut";

export interface DrawnSection {
  axis: 0 | 1 | 2;
  level: number;
  flipped: boolean;
  // Node coordinates as drawn, in node order.
  points: Float64Array;
  clip: THREE.Plane;
}

export function useResultSection(
  showResult: boolean,
  deformScale: number,
): DrawnSection | null {
  const section = useModelStore((s) => s.section);
  const result = useModelStore((s) => s.result);
  const nodes = useModelStore((s) => s.nodes);
  const points = useMemo(
    () =>
      result && result.displacements.length === nodes.length * 3
        ? deformedPoints(nodes, result.displacements, deformScale)
        : null,
    [result, nodes, deformScale],
  );
  return useMemo(() => {
    if (!showResult || !section || !points) return null;
    const level = sectionLevel(points, section.axis, section.position);
    return {
      axis: section.axis,
      level,
      flipped: section.flipped,
      points,
      clip: sectionClipPlane(section.axis, level, section.flipped),
    };
  }, [showResult, section, points]);
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The section plane of Results (KOF-390), around the Rust cut
// (crates/kofem-fem/src/section.rs, called as sectionCut): the model as drawn,
// where the slider puts the plane, the clipping plane that hides the removed
// part of the drawn surface, and the cut's cap and shell lines. The Rust
// module must be loaded first (loadFemModule).

import * as THREE from "three";
import { sectionCut } from "../wasm/fem/kofem_wasm.js";
import type { Element, LegendRange, Node } from "../store/modelStore";
import { tr } from "../i18n/useLocale";
import { resultsMessages } from "../i18n/messages/results";

/** Node coordinates as drawn: undeformed plus the scaled displacement. */
export function deformedPoints(
  nodes: Pick<Node, "x" | "y" | "z">[],
  displacements: Float64Array,
  scale: number,
): Float64Array {
  if (displacements.length !== nodes.length * 3)
    throw new Error(
      tr(resultsMessages).sectionStale(displacements.length, nodes.length),
    );
  const points = new Float64Array(nodes.length * 3);
  nodes.forEach((node, i) => {
    points[3 * i] = node.x + scale * displacements[3 * i];
    points[3 * i + 1] = node.y + scale * displacements[3 * i + 1];
    points[3 * i + 2] = node.z + scale * displacements[3 * i + 2];
  });
  return points;
}

/** The plane's coordinate: `position` (0…1) across the drawn extent along `axis`. */
export function sectionLevel(
  points: Float64Array,
  axis: 0 | 1 | 2,
  position: number,
): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = axis; i < points.length; i += 3) {
    lo = Math.min(lo, points[i]);
    hi = Math.max(hi, points[i]);
  }
  if (!(hi >= lo)) throw new Error(tr(resultsMessages).sectionNoNodes);
  return lo + position * (hi - lo);
}

/**
 * The clipping plane that keeps the part below the cut (coordinate ≤ level),
 * or above it when flipped. three.js keeps what lies on the plane's positive
 * side.
 */
export function sectionClipPlane(
  axis: 0 | 1 | 2,
  level: number,
  flipped: boolean,
): THREE.Plane {
  const normal = new THREE.Vector3();
  normal.setComponent(axis, flipped ? 1 : -1);
  return new THREE.Plane(normal, flipped ? -level : level);
}

/** The cut as the viewport draws it, and the field's range on it. */
export interface SectionGeometry {
  capPositions: Float32Array;
  capValues: Float64Array;
  capTriangles: Uint32Array;
  linePositions: Float32Array;
  lineValues: Float64Array;
  range: LegendRange | null;
}

/**
 * Cut the drawn model: solid elements into a filled cap, shell facets into
 * lines, the field interpolated along the cut edges. `index` maps a node id to
 * its position in `points` and `values`.
 */
export function cutSection(
  points: Float64Array,
  values: Float64Array,
  elements: { tets: Element[]; hexes: Element[]; shells: Element[] },
  index: (id: number) => number,
  plane: { axis: 0 | 1 | 2; level: number; flipped: boolean },
): SectionGeometry {
  const corners = (list: Element[], count: number) => {
    const out = new Uint32Array(list.length * count);
    list.forEach((element, e) => {
      for (let k = 0; k < count; k++)
        out[e * count + k] = index(element.nodeIds[k]);
    });
    return out;
  };
  const cut = sectionCut(
    points,
    values,
    corners(elements.tets, 4),
    corners(elements.hexes, 8),
    corners(elements.shells, 3),
    plane.axis,
    plane.level,
    plane.flipped,
  );
  const capValues = cut.capValues;
  const lineValues = cut.lineValues;
  const geometry = {
    capPositions: Float32Array.from(cut.capPoints),
    capValues,
    capTriangles: cut.capTriangles,
    linePositions: Float32Array.from(cut.linePoints),
    lineValues,
  };
  cut.free();
  let min = Infinity;
  let max = -Infinity;
  for (const value of capValues) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  for (const value of lineValues) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { ...geometry, range: min <= max ? { min, max } : null };
}

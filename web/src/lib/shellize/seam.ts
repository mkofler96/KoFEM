// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The shell↔solid seam: which shell nodes sit on the retained solid and so
// become references of the continuity tie.

import { TriangleGrid } from "../spatialGrid.js";
import { triangleExtent, type Vec3 } from "./geometry.js";

// The shell mid-surface nodes that lie ON the retained solid — the seam where an
// idealised wall meets material that stayed solid. These, and only these, are the
// references of the shell↔solid tie.
//
// The reference set used to be "every shell node with ≥ 3 solid nodes within
// couplingRadius" — a ball of fixed 10 mm, an absolute length with no relation to
// the part being analysed. Every shell node it caught became rigidly tied to the
// solid, so on the 2 mm fin of fin_two_parts.step the top 9.8 mm of the wall was
// clamped to the block: the cantilever was shortened and its tip deflection came
// out 26 % stiff. Whether a node is at the seam is a geometric fact, not a
// distance-to-nodes question, so test it directly against the retained solid's
// BOUNDARY SURFACE. The tolerance is one wall thickness: the mid-surface sits t/2
// inside the original wall face, so a seam node can be up to t/2 off the solid
// boundary, and t leaves margin for a curved or coarsely faceted seam.
export function seamShellNodes(
  ppt: (i: number) => Vec3,
  shellPoolIndices: number[],
  solidBoundary: number[],
  tolerance: number,
): number[] {
  const nTris = solidBoundary.length / 3;
  if (nTris === 0 || tolerance <= 0) return [];
  const corner = (t: number, k: number): Vec3 => ppt(solidBoundary[3 * t + k]);
  let sumExtent = 0;
  for (let t = 0; t < nTris; t++) sumExtent += triangleExtent(corner, t);
  const grid = new TriangleGrid(
    nTris,
    corner,
    Math.max(tolerance, sumExtent / nTris, 1e-9),
  );
  const tol2 = tolerance * tolerance;
  return shellPoolIndices.filter((pi) =>
    grid.anyNear(ppt(pi), (d2) => d2 <= tol2),
  );
}

// How far off the retained solid's boundary a shell node may sit and still count
// as seam. The seam is a wall-thickness-scale feature, but a DISCRETISED seam is
// only located to within the local element size: with 0.5 mm walls on a 6 mm mesh
// the crane holder's junction ring lands well off the solid's faceted boundary,
// and a wall-thickness tolerance found so few seam nodes that the shell hinged
// there (max |u| 0.16 mm at 4 mm elements but 8.1 mm at 8 mm — no convergence at
// all). So the tolerance carries both scales: one wall thickness, or half an
// element, whichever is larger. Unlike a fixed radius it shrinks as the mesh is
// refined, so the tied band is mesh-convergent rather than a constant bite out of
// the structure.
export function seamTolerance(
  maxWallThickness: number,
  medEdge: number,
): number {
  return Math.max(maxWallThickness, 0.5 * medEdge);
}

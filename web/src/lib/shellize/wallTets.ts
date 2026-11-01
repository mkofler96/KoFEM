// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Which solid tets the shell mid-surface replaces.

import { TriangleGrid } from "../spatialGrid.js";
import {
  pt,
  tetVolume,
  triangleExtent,
  type ShellizeMesh,
  type Vec3,
} from "./geometry.js";
import type { ShellExtraction } from "./midSurface.js";

// Corner accessor for the shell mid-surface facets.
function midSurfaceCorner(
  shells: ShellExtraction,
): (t: number, k: number) => Vec3 {
  const sv = shells.shellVerts;
  return (t, k) => {
    const i = shells.shellTris[3 * t + k];
    return [sv[3 * i], sv[3 * i + 1], sv[3 * i + 2]];
  };
}

// The tets of the shelled body that the shell facets REPLACE: those lying inside
// a detected thin wall. A tet is inside a wall exactly when its centroid is
// within half that wall's thickness of the wall's mid-surface — the geometric
// statement of "this material is now carried by the shell". Everything farther
// away — the thick junction/base blocks that connect the body to its neighbours —
// stays a solid tet, so its stiffness and its contact with the neighbours are
// preserved. Collapsing the WHOLE body to shells silently dropped those blocks
// (the crane holder lost ~30 % of its volume, exactly the block carrying load
// into the hook), leaving the shells floating with only a proximity coupling to
// the solids.
//
// This used to be a SHAPE test (tet flatness below a fixed ratio), on the
// assumption that a thin wall is always filled by flat slivers. Netgen refines
// across a thin wall until its elements are well formed, so most wall tets pass
// that test: the wall was represented twice — shell facets laid over retained
// solid tets — by a fraction that moved with element size. On the 2 mm fin of
// fin_two_parts.step, 68 % of the wall tets survived at 20 mm elements and
// 99.8 % at 6 mm, while the shell covered the wall in full.
export function shellWallTets(
  m: ShellizeMesh,
  shells: ShellExtraction,
  { margin = 1.0 }: { margin?: number } = {},
): Set<number> {
  const wallTets = new Set<number>();
  const nFacets = shells.shellTris.length / 3;
  if (nFacets === 0) return wallTets;

  const facetPt = midSurfaceCorner(shells);
  // Cell ≥ the largest query radius (half the thickest wall) and ≥ the facet
  // extent, so a facet spans only a few cells.
  let maxThk = 0,
    sumExtent = 0;
  for (let t = 0; t < nFacets; t++) {
    if (shells.shellThk[t] > maxThk) maxThk = shells.shellThk[t];
    sumExtent += triangleExtent(facetPt, t);
  }
  const grid = new TriangleGrid(
    nFacets,
    facetPt,
    Math.max(maxThk * margin, sumExtent / nFacets, 1e-9),
  );

  for (let e = 0; e < m.tet.length / 4; e++) {
    if (m.body[e] !== shells.shellBody) continue;
    const centroid: Vec3 = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const node = pt(m.V, m.tet[4 * e + k]);
      centroid[0] += node[0] / 4;
      centroid[1] += node[1] / 4;
      centroid[2] += node[2] / 4;
    }
    const inside = grid.anyNear(centroid, (dist2, t) => {
      const reach = 0.5 * shells.shellThk[t] * margin;
      return dist2 <= reach * reach;
    });
    if (inside) wallTets.add(e);
  }
  return wallTets;
}

// Every tet of the shelled body — what the app replaces with shell facets. A
// body the user marks Shell is idealised as shells everywhere, not just where a
// thin wall was detected: a part that is only partly thin-walled is split into
// bodies first and only the thin ones are marked, so no thick block of a Shell
// body is left behind as solid (shellWallTets keeps those, for the dev scripts
// that shell an unsplit part).
//
// Replacing the whole body is only sound when the detected walls cover all of
// it. Wall detection pairs opposite PLANAR faces of a useful size, so a curved
// wall, a small tab or a thick block yields no facets — dropping its tets would
// quietly remove material and change the load path. Such a body is refused,
// with the share of it the shells would lose.
export function shellBodyTets(
  m: ShellizeMesh,
  shells: ShellExtraction,
): Set<number> {
  const tets = new Set<number>();
  for (let e = 0; e < m.tet.length / 4; e++)
    if (m.body[e] === shells.shellBody) tets.add(e);
  const covered = shellWallTets(m, shells);
  let lostVolume = 0,
    bodyVolume = 0,
    lost = 0;
  for (const e of tets) {
    const volume = tetVolume(m, e);
    bodyVolume += volume;
    if (covered.has(e)) continue;
    lost++;
    lostVolume += volume;
  }
  if (lost > 0)
    throw new Error(
      `Body ${shells.shellBody} is marked "Shell", but ${lost} of its ${tets.size} ` +
        `elements (${((100 * lostVolume) / bodyVolume).toFixed(1)} % of its volume) ` +
        "lie outside every flat thin wall the shell idealisation found — a curved " +
        "or small face, or a thick block, that the shells would drop. Split that " +
        "part into a body of its own and keep it Solid, or set the body to Solid.",
    );
  return tets;
}

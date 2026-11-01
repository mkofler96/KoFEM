// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Distributing-coupling partner search shared by the shell↔solid seam and the
// tie connections: which solid nodes each reference node ties to.

import { SpatialGrid } from "../spatialGrid.js";
import { dist2, type Vec3 } from "./geometry.js";

// Distance a coupling reference may reach to find its solid partners. It has to
// span at least one solid element, otherwise a seam node on a coarse mesh finds
// fewer than the three partners an RBE3/MPC needs and is silently dropped; beyond
// that it only widens the patch the tie distributes over.
export function partnerSearchRadius(medEdge: number, floor: number): number {
  return Math.max(2 * medEdge, floor, 1e-9);
}

// Pick at most `budget` of the candidates found in the search ball, keeping the
// PATCH WIDE: the nearest node first (the MPC tie needs it), then repeatedly the
// candidate farthest from everything already chosen. Taking the `budget` nearest
// instead makes the patch shrink with the element size — at 6 mm elements the 16
// nearest spanned 6.6 mm, at 2 mm only 3.9 mm — while the reference stays put, so
// the RBE3 inertia H = Σ wᵢ(|rᵢ|²I − rᵢrᵢᵀ) tends to its singular limit (all rᵢ
// parallel) as the mesh is refined. Measured on the crane hook, cond(H) doubled
// per halving of the element size, and Hinv scales the constraint's rotation rows
// (build_rbe3_constraints), so that lands in Kᵣ = TᵀKT squared. A patch that
// keeps the search ball's width instead is as well-conditioned at 1 mm as at 6.
function spreadPatch(
  candidates: { pi: number; d2: number }[],
  budget: number,
  ppt: (i: number) => Vec3,
): number[] {
  if (candidates.length <= budget) return candidates.map((c) => c.pi);
  const chosen = [candidates.reduce((a, b) => (a.d2 <= b.d2 ? a : b)).pi];
  const rest = candidates.filter((c) => c.pi !== chosen[0]).map((c) => c.pi);
  // Distance from each remaining candidate to the nearest chosen node, updated
  // incrementally as the patch grows (farthest-point sampling).
  const sep = rest.map((pi) => dist2(ppt(pi), ppt(chosen[0])));
  while (chosen.length < budget) {
    let best = -1;
    for (let i = 0; i < rest.length; i++)
      if (sep[i] > (best < 0 ? -1 : sep[best])) best = i;
    if (best < 0) break;
    const picked = rest[best];
    chosen.push(picked);
    sep[best] = -1; // never picked again
    for (let i = 0; i < rest.length; i++)
      if (sep[i] >= 0)
        sep[i] = Math.min(sep[i], dist2(ppt(rest[i]), ppt(picked)));
  }
  return chosen;
}

// Auto-detect distributing (RBE3) couplings: every reference (shell) node that
// has ≥3 solid nodes within couplingRadius ties to them. Emitted CSR-style —
// ref[k] ties to solid[offsets[k]..offsets[k+1]). At most `maxCoupledNodes` solid
// candidates are kept per coupling — the RBE3 master-slave expansion is quadratic
// in that count, so a radius alone picks hundreds of nodes on a fine mesh and the
// reduction dominates the solve — chosen for spread, see spreadPatch.
export function autoDetectCouplings(
  ppt: (i: number) => Vec3,
  solidPoolIndices: Iterable<number>,
  refPoolIndices: Iterable<number>,
  radius: number,
  maxCoupledNodes: number,
): { ref: number[]; offsets: number[]; solid: number[] } {
  const grid = new SpatialGrid(solidPoolIndices, ppt, radius);
  const ref: number[] = [],
    offsets = [0],
    solid: number[] = [];
  for (const gi of refPoolIndices) {
    const pos = ppt(gi);
    const near: { pi: number; d2: number }[] = [];
    for (const pi of grid.candidates(pos, 1)) {
      const d2 = dist2(pos, ppt(pi));
      if (d2 <= radius * radius) near.push({ pi, d2 });
    }
    if (near.length >= 3) {
      ref.push(gi);
      for (const pi of spreadPatch(near, maxCoupledNodes, ppt)) solid.push(pi);
      offsets.push(solid.length);
    }
  }
  return { ref, offsets, solid };
}

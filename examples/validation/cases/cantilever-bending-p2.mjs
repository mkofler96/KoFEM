// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cantilever beam, second-order (P2) elements — regression guard for the
// element_order = 2 solver path (added in PR #281, issue #303).
//
//   Same beam as cantilever-bending.mjs (fixed at x=0, transverse tip load P),
//   tip deflection δ = P·L³ / (3·E·I),  I = b·h³/12.
//
// The mesh here is deliberately COARSE (10×2×2 hexes). Linear (P1) hexes
// shear-lock badly on a span this coarse — they predict only ~70% of the true
// tip deflection (~30% error). Quadratic (P2) elements on the *same* mesh
// recover the deflection to <2%, so this case both:
//
//   1. exercises the order ≥ 2 branch in solve_mfem.cpp that order-1 cases
//      never touch — the edge-midpoint Dirichlet extension that clamps the
//      mid-edge DOFs on the x=0 face, and the tight 1e-6 CG tolerance with the
//      raised iteration cap, and
//   2. asserts P2 is materially more accurate than P1 on the same elements;
//      the 4% tolerance is comfortably below P1's ~30% error here, so a
//      regression that drops the P2 DOFs back to P1 behaviour (or fails to
//      constrain edge midpoints) breaks this case.
//
// Reference: Euler–Bernoulli beam theory (Gere & Goodno, deflections of beams).

import { boxHexMesh, nodesWhere, distributeForce } from "../lib/mesh.mjs";

const E = 210e9; // Pa
const nu = 0.3;
const L = 1.0; // m
const b = 0.1,
  h = 0.1; // cross-section (m)
const P = 1.0e4; // tip load (N), downward

const I = (b * h ** 3) / 12;

export default {
  name: "Cantilever beam (P2, coarse mesh)",
  quantity: "tip deflection δ",
  unit: "m",
  reference: -(P * L ** 3) / (3 * E * I), // downward
  referenceLabel: "δ = P·L³ / (3·E·I)",
  tolPct: 4,
  run(solve) {
    const m = boxHexMesh(L, b, h, 10, 2, 2);
    const fixed = nodesWhere(m.vertices, (x) => x <= 1e-9);
    const loaded = nodesWhere(m.vertices, (x) => x >= L - 1e-9);
    const result = solve(
      { vertices: m.vertices, hexahedra: m.hexahedra },
      { young_modulus: E, poisson_ratio: nu, density: 7850 },
      {
        fixed_vertices: fixed,
        point_loads: distributeForce(loaded, [0, -P, 0]),
      },
      2, // second-order (P2) elements
    );
    return (
      loaded.reduce((s, v) => s + result.displacements[v * 3 + 1], 0) /
      loaded.length
    );
  },
};

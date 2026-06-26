// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cantilever beam with an end load — classic Euler–Bernoulli bending check.
//
//   Beam fixed at x=0, transverse tip load P over the x=L face.
//   Tip deflection:  δ = P·L³ / (3·E·I),   I = b·h³/12.
//
// Linear hexes shear-lock in bending, so the mesh is refined along the span
// (40 elements) to bring the FE deflection within a few percent — exactly the
// trade-off documented in web/tests/cantilever-solve.spec.ts.
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
  name: "Cantilever beam (end load)",
  quantity: "tip deflection δ",
  unit: "m",
  reference: -(P * L ** 3) / (3 * E * I), // downward
  referenceLabel: "δ = P·L³ / (3·E·I)",
  tolPct: 6,
  run(solve) {
    const m = boxHexMesh(L, b, h, 40, 4, 4);
    const fixed = nodesWhere(m.vertices, (x) => x <= 1e-9);
    const loaded = nodesWhere(m.vertices, (x) => x >= L - 1e-9);
    const result = solve(
      { vertices: m.vertices, hexahedra: m.hexahedra },
      { young_modulus: E, poisson_ratio: nu, density: 7850 },
      {
        fixed_vertices: fixed,
        point_loads: distributeForce(loaded, [0, -P, 0]),
      },
      1,
    );
    return (
      loaded.reduce((s, v) => s + result.displacements[v * 3 + 1], 0) /
      loaded.length
    );
  },
};

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
const DIV = [40, 4, 4]; // elements along x, y, z

const I = (b * h ** 3) / 12;

// The beam's inputs, shared with the P2 case and the convergence study.
export const cantileverInputs = [
  ["L", L, "m"],
  ["b × h", `${b} × ${h}`, "m"],
  ["E", E, "Pa"],
  ["ν", nu, ""],
  ["P", P, "N"],
];
export const cantileverReference = -(P * L ** 3) / (3 * E * I); // downward

/**
 * Mean y-deflection of the loaded end face for an nx × ny × nz hex grid at
 * element order `order`, with the tip load split equally over the face nodes.
 */
export function cantileverTip(solve, [nx, ny, nz], order) {
  const m = boxHexMesh(L, b, h, nx, ny, nz);
  const fixed = nodesWhere(m.vertices, (x) => x <= 1e-9);
  const loaded = nodesWhere(m.vertices, (x) => x >= L - 1e-9);
  const result = solve(
    { vertices: m.vertices, hexahedra: m.hexahedra },
    { young_modulus: E, poisson_ratio: nu, density: 7850 },
    {
      fixed_vertices: fixed,
      point_loads: distributeForce(loaded, [0, -P, 0]),
    },
    order,
  );
  return (
    loaded.reduce((s, v) => s + result.displacements[v * 3 + 1], 0) /
    loaded.length
  );
}

export default {
  id: "cantilever",
  name: "Cantilever beam (end load)",
  quantity: "tip deflection δ",
  unit: "m",
  reference: cantileverReference,
  referenceLabel: "δ = P·L³ / (3·E·I)",
  tolPct: 6,
  page: {
    summary:
      "Classic bending check. Linear hexahedra are too stiff in bending (shear locking).",
    model: "Beam of span L along x, b × h section, I = b·h³/12.",
    inputs: cantileverInputs,
    supports: "x = 0 face clamped.",
    loads: "P in −y, split equally over the x = L face nodes.",
    measured: "Mean y-displacement of the x = L face.",
    mesh: `${DIV.join(" × ")} grid`,
    source: "Euler–Bernoulli beam theory",
  },
  run(solve) {
    return cantileverTip(solve, DIV, 1);
  },
};

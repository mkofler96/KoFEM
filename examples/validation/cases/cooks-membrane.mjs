// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cook's membrane — the standard tapered-cantilever benchmark for combined
// bending and shear under a skewed, trapezoidal geometry.
//
//   Trapezoid (0,0)-(48,44)-(48,60)-(0,44), clamped on the left edge, unit
//   shear load distributed over the right edge. The benchmark quantity is the
//   vertical deflection of the top-right corner (48,60). The widely cited
//   converged reference is ≈ 23.9.
//
// Reference: R.D. Cook, "Improved two-dimensional finite element",
// J. Struct. Div. ASCE (1974); used throughout the FE literature as a
// distortion/locking benchmark.

import { cookMembraneMesh, nodesWhere, distributeForce } from "../lib/mesh.mjs";

const E = 1.0;
const nu = 1 / 3;
const t = 1.0; // thin slab ⇒ plane-stress-like
const F = 1.0; // total shear load

export default {
  name: "Cook's membrane",
  quantity: "top-corner deflection",
  unit: "",
  reference: 23.9,
  referenceLabel: "converged ≈ 23.9",
  tolPct: 6,
  run(solve) {
    const m = cookMembraneMesh(16, 16, t);
    const clamp = nodesWhere(m.vertices, (x) => x <= 1e-9);
    const right = nodesWhere(m.vertices, (x) => x >= 48 - 1e-9);
    const corner = nodesWhere(
      m.vertices,
      (x, y) => x >= 48 - 1e-9 && y >= 60 - 1e-9,
    );
    const result = solve(
      { vertices: m.vertices, hexahedra: m.hexahedra },
      { young_modulus: E, poisson_ratio: nu, density: 1 },
      { fixed_vertices: clamp, point_loads: distributeForce(right, [0, F, 0]) },
      1,
    );
    return (
      corner.reduce((s, v) => s + result.displacements[v * 3 + 1], 0) /
      corner.length
    );
  },
};

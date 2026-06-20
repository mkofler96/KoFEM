// Axial bar in uniaxial tension — the simplest sanity benchmark.
//
//   A prismatic bar, fixed at x=0, pulled by a total axial force P over the x=L
//   face. Closed-form tip extension:  δ = P·L / (E·A).
//
// Reference: any mechanics-of-materials text (e.g. Gere & Goodno, "Mechanics of
// Materials", axially loaded members).

import { boxHexMesh, nodesWhere, distributeForce } from "../lib/mesh.mjs";

const E = 210e9; // Pa
const nu = 0.3;
const L = 1.0; // m
const W = 0.1,
  H = 0.1; // cross-section (m)
const P = 1.0e6; // total axial force (N)

export default {
  name: "Axial bar (uniaxial tension)",
  quantity: "tip extension δ",
  unit: "m",
  reference: (P * L) / (E * (W * H)), // δ = PL/EA
  referenceLabel: "δ = P·L / (E·A)",
  tolPct: 2,
  run(solve) {
    const m = boxHexMesh(L, W, H, 20, 4, 4);
    const fixed = nodesWhere(m.vertices, (x) => x <= 1e-9);
    const loaded = nodesWhere(m.vertices, (x) => x >= L - 1e-9);
    const result = solve(
      { vertices: m.vertices, hexahedra: m.hexahedra },
      { young_modulus: E, poisson_ratio: nu, density: 7850 },
      {
        fixed_vertices: fixed,
        point_loads: distributeForce(loaded, [P, 0, 0]),
      },
      1,
    );
    const ux =
      loaded.reduce((s, v) => s + result.displacements[v * 3], 0) /
      loaded.length;
    return ux;
  },
};

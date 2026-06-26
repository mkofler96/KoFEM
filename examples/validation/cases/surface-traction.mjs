// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Axial bar pulled by a surface traction — validates the work-equivalent surface
// load path (VectorBoundaryLFIntegrator) rather than lumped nodal point loads.
//
//   A prismatic bar fixed at x=0 carries a total axial force P spread as a uniform
//   traction over the x=L face. The engine integrates f_i = ∫ N_i·t dS, so the
//   resultant equals P and the tip extension matches the closed form δ = P·L/(E·A)
//   exactly as a point-load distribution would — but without the shape-function
//   weighting error or the mesh-density-dependent moment of an equal nodal split.
//
// Reference: Gere & Goodno, "Mechanics of Materials", axially loaded members.

import { boxHexMesh, nodesWhere, boxMaxXQuads } from "../lib/mesh.mjs";

const E = 210e9; // Pa
const nu = 0.3;
const L = 1.0; // m
const W = 0.1,
  H = 0.1; // cross-section (m)
const P = 1.0e6; // total axial force (N), applied as a surface traction

export default {
  name: "Surface traction (axial bar)",
  quantity: "tip extension δ",
  unit: "m",
  reference: (P * L) / (E * (W * H)), // δ = PL/EA
  referenceLabel: "δ = P·L / (E·A)",
  tolPct: 2,
  run(solve) {
    const nx = 20,
      ny = 4,
      nz = 4;
    const m = boxHexMesh(L, W, H, nx, ny, nz);
    const fixed = nodesWhere(m.vertices, (x) => x <= 1e-9);
    const loaded = nodesWhere(m.vertices, (x) => x >= L - 1e-9);
    const result = solve(
      { vertices: m.vertices, hexahedra: m.hexahedra },
      { young_modulus: E, poisson_ratio: nu, density: 7850 },
      {
        fixed_vertices: fixed,
        surface_loads: [
          {
            type: "force",
            force: [P, 0, 0],
            triangles: boxMaxXQuads(m.nid, nx, ny, nz),
          },
        ],
      },
      1,
    );
    return (
      loaded.reduce((s, v) => s + result.displacements[v * 3], 0) /
      loaded.length
    );
  },
};

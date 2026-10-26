// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Uniform pressure on the end of an axial bar — validates the pressure load path
// (traction = -p·n̂ over the loaded face) including its sign.
//
//   A prismatic bar fixed at x=0 carries a uniform pressure p on the x=L face.
//   Pressure acts along the inward normal (-x here), so the bar is in uniaxial
//   compression with σ_xx = -p everywhere, giving tip displacement
//       u(L) = -p·L / E
//   independent of the cross-section. A flipped pressure sign (tension) or a
//   missing area normalisation would put this far outside tolerance.

import { boxHexMesh, nodesWhere, boxMaxXQuads } from "../lib/mesh.mjs";

const E = 210e9; // Pa
const nu = 0.3;
const L = 1.0; // m
const W = 0.1,
  H = 0.1; // cross-section (m)
const p = 1.0e6; // pressure (Pa), pushes inward on the x=L face → compression
const DIV = [20, 4, 4]; // elements along x, y, z

export default {
  id: "surface-pressure",
  name: "Surface pressure (axial bar)",
  quantity: "tip displacement u",
  unit: "m",
  reference: -(p * L) / E, // u(L) = -p·L/E (compression)
  referenceLabel: "u = -p·L / E",
  tolPct: 2,
  page: {
    summary:
      "The axial bar compressed by an end pressure: checks the pressure sign and area scaling.",
    model: "Prismatic bar of length L along x, W × H section.",
    inputs: [
      ["L", L, "m"],
      ["W × H", `${W} × ${H}`, "m"],
      ["E", E, "Pa"],
      ["ν", nu, ""],
      ["p", p, "Pa"],
    ],
    supports: "x = 0 face clamped.",
    loads: "Uniform pressure p on the x = L face.",
    measured: "Mean x-displacement of the x = L face.",
    mesh: `${DIV.join(" × ")} grid`,
    source: "Uniaxial compression, σ = −p",
  },
  run(solve) {
    const [nx, ny, nz] = DIV;
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
            type: "pressure",
            pressure: p,
            faces: boxMaxXQuads(m.nid, nx, ny, nz),
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

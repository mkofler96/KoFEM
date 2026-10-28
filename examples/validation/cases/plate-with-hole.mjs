// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Plate with a central circular hole — the Kirsch stress-concentration problem.
//
//   A wide plate (half-width b ≫ hole radius a) in uniaxial tension σ. At the
//   hole edge transverse to the load the stress peaks at  σ_max = Kt·σ  with the
//   theoretical concentration factor  Kt = 3  for an infinite plate.
//
// This is a stress-driven case, so it is the hardest to nail with linear hexes
// (constant stress per element) and the engine's loose CG tolerance — expect a
// few-percent-to-low-double-digit overshoot, not the sub-percent agreement of
// the displacement cases. The tolerance band reflects that honestly.
//
// Reference: Kirsch (1898); Timoshenko & Goodier, "Theory of Elasticity",
// stress around a circular hole in a plate.

import {
  plateWithHoleMesh,
  nodesWhere,
  distributeForce,
} from "../lib/mesh.mjs";

const E = 210e9; // Pa
const nu = 0.3;
const a = 1.0, // hole radius (m)
  b = 10.0, // plate half-width (m) — a/b = 0.1 ⇒ ≈ infinite-plate Kt
  t = 0.5; // thickness (m)
const sigma = 100e6; // applied gross tension (Pa)
const NR = 12, // element rings from the hole to the outer edge
  NTH = 64, // elements around the hole
  GRADE = 2; // ring spacing ∝ s^GRADE, clustered at the hole

// The O-grid, for the case page's analysis of where the peak is sampled.
export const plateMesh = { a, b, nr: NR, nth: NTH, grade: GRADE };

export default {
  id: "plate-with-hole",
  name: "Plate with a hole (Kirsch)",
  quantity: "stress-concentration factor Kt",
  unit: "",
  reference: 3.0,
  referenceLabel: "Kt = 3 (infinite plate)",
  tolPct: 15,
  page: {
    summary:
      "Kirsch stress concentration at a hole — the one stress-based case, hence the wider band.",
    model:
      "Square plate of half-width b and thickness t, central hole of radius a.",
    inputs: [
      ["a", a, "m"],
      ["b", b, "m"],
      ["t", t, "m"],
      ["E", E, "Pa"],
      ["ν", nu, ""],
      ["σ", sigma, "Pa"],
    ],
    supports: "x = −b face clamped.",
    loads: "σ·2b·t in +x, split equally over the x = +b face nodes.",
    measured:
      "Peak element-centre von Mises stress around the hole, divided by σ.",
    mesh: `O-grid, ${NR} rings × ${NTH} around the hole, 1 through t`,
    source: "Kirsch (1898); Timoshenko & Goodier",
  },
  run(solve) {
    const m = plateWithHoleMesh(a, b, t, NR, NTH, GRADE);
    const left = nodesWhere(m.vertices, (x) => x <= -b + 1e-6);
    const right = nodesWhere(m.vertices, (x) => x >= b - 1e-6);
    const P = sigma * (2 * b * t); // gross axial force
    const result = solve(
      { vertices: m.vertices, hexahedra: m.hexahedra },
      { young_modulus: E, poisson_ratio: nu, density: 7850 },
      {
        fixed_vertices: left,
        point_loads: distributeForce(right, [P, 0, 0]),
      },
      1,
    );
    // Peak von Mises sits in the hole-ring elements (the first nth hexes).
    let peak = 0;
    for (let e = 0; e < m.nth; e++) peak = Math.max(peak, result.von_mises[e]);
    return peak / sigma; // Kt
  },
};

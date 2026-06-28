// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Square prismatic beam under torsion — Saint-Venant torsion of a non-circular
// section, the torsional counterpart to the cantilever-bending case.
//
//   The same beam (fixed at x=0, square b×b cross-section, length L) is twisted
//   by a torque T about its own axis applied over the x=L face. Unlike a circular
//   shaft the cross-section warps, so the angle of twist uses the torsion
//   constant K (not the polar moment J):
//        θ = T·L / (G·K),   K = β·b⁴,   β = 1/3 − 0.21·(1 − 1/12) ≈ 0.1408
//        G = E / [2(1+ν)].
//   (β is the b/a → 1 limit of the rectangular-bar constant
//    K = a·b³·[1/3 − 0.21·(b/a)·(1 − b⁴/(12a⁴))], a ≥ b.)
//
//   The torque is applied as tangential nodal forces scaled ∝ r so the net force
//   is zero and the net moment about x is exactly T (the same work-equivalent
//   couple the UI builds for a moment load). This is not the exact Saint-Venant
//   end traction for a square, but by Saint-Venant's principle the twist away
//   from the end is unaffected; the free-end twist is read back from the
//   tangential displacement, a displacement quantity that validates tightly. The
//   ~2% under-prediction is the physical warping restraint of the clamped end.
//
// Reference: Saint-Venant torsion of a square bar (Timoshenko & Goodier, "Theory
// of Elasticity", torsion of prismatic bars; Roark's rectangular-section K).

import { boxHexMesh, nodesWhere } from "../lib/mesh.mjs";

const E = 210e9; // Pa
const nu = 0.3;
const G = E / (2 * (1 + nu));
const L = 1.0; // m
const b = 0.1; // square side (m)
const T = 1000; // N·m about x

const beta = 1 / 3 - 0.21 * (1 - 1 / 12); // square-section (b/a = 1) constant
const K = beta * b ** 4;

export default {
  name: "Square beam under torsion",
  quantity: "angle of twist θ",
  unit: "rad",
  reference: (T * L) / (G * K),
  referenceLabel: "θ = T·L / (G·K)",
  tolPct: 5,
  run(solve) {
    const m = boxHexMesh(L, b, b, 20, 6, 6);
    const fixed = nodesWhere(m.vertices, (x) => x <= 1e-9);
    const tip = nodesWhere(m.vertices, (x) => x >= L - 1e-9);

    // Cross-section centroid of the loaded face (the torsion axis).
    const cy = tip.reduce((s, v) => s + m.vertices[v][1], 0) / tip.length;
    const cz = tip.reduce((s, v) => s + m.vertices[v][2], 0) / tip.length;

    // Tangential forces ∝ r about x, scaled so Σ r·ft = T (zero net force).
    const sumR2 = tip.reduce((s, v) => {
      const y = m.vertices[v][1] - cy,
        z = m.vertices[v][2] - cz;
      return s + y * y + z * z;
    }, 0);
    const c = T / sumR2;
    const loads = tip.map((v) => {
      const y = m.vertices[v][1] - cy,
        z = m.vertices[v][2] - cz;
      return { vertex: v, force: [0, -c * z, c * y] };
    });

    const result = solve(
      { vertices: m.vertices, hexahedra: m.hexahedra },
      { young_modulus: E, poisson_ratio: nu, density: 7850 },
      { fixed_vertices: fixed, point_loads: loads },
      1,
    );

    // θ = mean of (r × u)_x / r²  over the free-end face.
    return (
      tip.reduce((s, v) => {
        const y = m.vertices[v][1] - cy,
          z = m.vertices[v][2] - cz;
        const r2 = y * y + z * z;
        if (r2 < 1e-12) return s;
        const uy = result.displacements[v * 3 + 1],
          uz = result.displacements[v * 3 + 2];
        return s + (y * uz - z * uy) / r2;
      }, 0) /
      tip.filter((v) => {
        const y = m.vertices[v][1] - cy,
          z = m.vertices[v][2] - cz;
        return y * y + z * z >= 1e-12;
      }).length
    );
  },
};

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Hollow circular shaft under torsion — Saint-Venant torsion of a tube.
//
//   A hollow shaft (inner radius ri, outer ro, length L) clamped at z=0 with a
//   torque T applied at z=L. The angle of twist is
//        θ = T·L / (G·J),   J = π(ro⁴ − ri⁴)/2,   G = E / [2(1+ν)].
//
//   The torque is applied as tangential nodal forces scaled ∝ r (the τ ∝ r
//   Saint-Venant distribution) so the net force is zero and the net moment is T.
//   The twist is read back from the tangential displacement of the free end —
//   a displacement quantity, so it validates tightly.
//
// Reference: Saint-Venant torsion of circular shafts (Gere & Goodno, torsion).

import { annulusHexMesh, nodesWhere } from "../lib/mesh.mjs";

const E = 210e9; // Pa
const nu = 0.3;
const G = E / (2 * (1 + nu));
const ri = 0.03,
  ro = 0.05, // m
  L = 0.5; // m
const T = 2000; // N·m
const J = (Math.PI * (ro ** 4 - ri ** 4)) / 2;

export default {
  name: "Hollow shaft under torsion",
  quantity: "angle of twist θ",
  unit: "rad",
  reference: (T * L) / (G * J),
  referenceLabel: "θ = T·L / (G·J)",
  tolPct: 5,
  run(solve) {
    const m = annulusHexMesh(ri, ro, L, 3, 32, 12);
    const base = nodesWhere(m.vertices, (x, y, z) => z <= 1e-9);
    const tip = nodesWhere(m.vertices, (x, y, z) => Math.abs(z - L) <= 1e-9);

    // Tangential forces ∝ r, scaled so Σ r·ft = T.
    const sumR2 = tip.reduce((s, v) => {
      const [x, y] = m.vertices[v];
      return s + x * x + y * y;
    }, 0);
    const c = T / sumR2;
    const loads = tip.map((v) => {
      const [x, y] = m.vertices[v];
      const r = Math.hypot(x, y);
      const ft = c * r;
      return { vertex: v, force: [(-ft * y) / r, (ft * x) / r, 0] };
    });

    const result = solve(
      { vertices: m.vertices, hexahedra: m.hexahedra },
      { young_modulus: E, poisson_ratio: nu, density: 7850 },
      { fixed_vertices: base, point_loads: loads },
      1,
    );

    // θ = mean of (r × u)_z / r²  over the free-end ring.
    return (
      tip.reduce((s, v) => {
        const [x, y] = m.vertices[v];
        const ux = result.displacements[v * 3];
        const uy = result.displacements[v * 3 + 1];
        return s + (-ux * y + uy * x) / (x * x + y * y);
      }, 0) / tip.length
    );
  },
};

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
const DIV = [3, 32, 12]; // elements radial, around, along the axis

export const shaftReference = (T * L) / (G * J);

/**
 * Mean free-end twist of the shaft on an nr × nth × nz annulus grid
 * (radial × around × axial) at element order `order`.
 */
export function shaftTwist(solve, [nr, nth, nz], order) {
  const m = annulusHexMesh(ri, ro, L, nr, nth, nz);
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
    order,
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
}

export default {
  id: "shaft-torsion",
  name: "Hollow shaft under torsion",
  quantity: "angle of twist θ",
  unit: "rad",
  reference: shaftReference,
  referenceLabel: "θ = T·L / (G·J)",
  tolPct: 5,
  page: {
    summary:
      "Torsion of a tube; straight-sided elements make the circle a polygon.",
    model: "Tube of length L along z, radii rᵢ and rₒ; J = π·(rₒ⁴ − rᵢ⁴)/2.",
    inputs: [
      ["L", L, "m"],
      ["rᵢ", ri, "m"],
      ["rₒ", ro, "m"],
      ["E", E, "Pa"],
      ["ν", nu, ""],
      ["T", T, "N·m"],
    ],
    supports: "z = 0 end clamped.",
    loads: "Torque T on the z = L end as tangential nodal forces ∝ r.",
    measured: "Mean rotation of the z = L end about the axis.",
    mesh: `${DIV.join(" × ")} grid (radial × around × axial)`,
    source: "Gere & Goodno, Mechanics of Materials",
  },
  run(solve) {
    return shaftTwist(solve, DIV, 1);
  },
};

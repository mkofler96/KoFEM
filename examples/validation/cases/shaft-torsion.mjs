// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Hollow circular shaft under torsion — the textbook shaft formula.
//
//   Tube of length L along z, radii ri and ro, clamped at z=0, torque T about
//   z on the free end. Angle of twist θ = T·L / (G·J), J = π(ro⁴ − ri⁴)/2.
//   A circular section does not warp, so the 1-D theory holds for the solid.
//
// The torque is a moment load on the end ring, which the app turns into
// tangential nodal forces ∝ r. Straight-sided elements make each circle an
// inscribed polygon, which accounts for almost all of the error.
//
// Reference: Gere & Goodno, "Mechanics of Materials", torsion of circular bars.

import { annulusHexMesh, nodesWhere } from "../lib/mesh.mjs";
import { STEEL } from "../lib/app-model.mjs";

const E = STEEL.young_modulus; // MPa
const nu = STEEL.poisson_ratio;
const G = E / (2 * (1 + nu));
const ri = 30,
  ro = 50, // mm
  L = 500; // mm
const T = 2.0e6; // N·mm about z
const J = (Math.PI * (ro ** 4 - ri ** 4)) / 2;
const DIV = [3, 32, 12]; // elements radial, around, along the axis

export const shaftReference = (T * L) / (G * J);

/** The shaft on an nr × nth × nz annulus grid (radial × around × axial). */
export function shaftModel(title, [nr, nth, nz], order) {
  const m = annulusHexMesh(ri, ro, L, nr, nth, nz);
  return {
    title,
    mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
    material: STEEL,
    order,
    support: {
      nodes: nodesWhere(m.vertices, (x, y, z) => z <= 1e-9),
      label: "Clamped end z = 0",
    },
    load: {
      kind: "moment",
      axis: 2,
      value: T,
      nodes: nodesWhere(m.vertices, (x, y, z) => Math.abs(z - L) <= 1e-9),
      label: "Torque (about Z)",
    },
    resultType: "Displacement (magnitude)",
  };
}

/** Mean rotation of the end-ring nodes about z. */
export function shaftTwist(model, result) {
  const { vertices } = model.mesh;
  const tip = model.load.nodes;
  return (
    tip.reduce((s, v) => {
      const [x, y] = vertices[v];
      const ux = result.displacements[3 * v];
      const uy = result.displacements[3 * v + 1];
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
  readout: { field: "|U|", stat: "Max" },
  page: {
    summary:
      "Torsion of a tube. Straight-sided elements make the circle a polygon.",
    model: "Tube of length L along z, radii rᵢ and rₒ; J = π·(rₒ⁴ − rᵢ⁴)/2.",
    inputs: [
      ["L", L, "mm"],
      ["rᵢ", ri, "mm"],
      ["rₒ", ro, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["T", T, "N·mm"],
    ],
    supports: "z = 0 end fixed (Ux, Uy, Uz).",
    loads: "Torque T about z as a moment on the z = L end.",
    measured: "Mean rotation of the z = L end about the axis.",
    mesh: `${DIV.join(" × ")} grid (radial × around × axial)`,
    source: "Gere & Goodno, Mechanics of Materials",
    grid: DIV,
  },
  model() {
    return shaftModel(this.name, DIV, 1);
  },
  measure: shaftTwist,
};

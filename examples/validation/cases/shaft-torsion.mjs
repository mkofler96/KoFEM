// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Hollow circular shaft under torsion — the textbook shaft formula.
//
//   Tube of length L along z, radii ri and ro, clamped at z=0, torque T about
//   z on the free end. Angle of twist θ = T·L / (G·J), J = π(ro⁴ − ri⁴)/2.
//   A circular section does not warp, so the 1-D theory holds for the solid.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the tube as a
// STEP file, mesh it with Netgen (quadratic tetrahedra, 10 mm), fix the z = 0
// end, put a moment about z on the z = L end, solve, and read the mean
// rotation of the loaded end in the Results panel's hand check.
//
// Why P2 at 10 mm (convergence.mjs): linear tetrahedra, two through the
// 20 mm wall, are far too stiff in torsion and approach the reference from
// below (−5.9 % at 10 mm), so a pass on a coarser or finer P1 mesh would only
// be the stiffness cancelling the polygon error. Quadratic tetrahedra
// converge from above, about +5.5 % at 20 mm down to +0.7 % at 5 mm: what
// remains is the straight-sided polygon in place of each circle and the local
// give under the nodal forces of the end face, where the twist is read. Both
// shrink with the element size. At 20 mm the bore is too coarse a polygon;
// 10 mm (about +2 %) is the coarsest size well inside the 5 % band.
//
// Reference: Gere & Goodno, "Mechanics of Materials", torsion of circular bars.

import { annulusStep } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const G = E / (2 * (1 + nu));
const ri = 30, // mm
  ro = 50, // mm
  L = 500; // mm, along z
const T = 2.0e6; // N·mm about z
const J = (Math.PI * (ro ** 4 - ri ** 4)) / 2;

// A point on each end ring, midway through the wall: what a user clicks to
// pick the end face.
const rm = (ri + ro) / 2;
const fixedEnd = { at: [0, rm, 0] };
const loadedEnd = { at: [0, rm, L] };

export default {
  id: "shaft-torsion",
  name: "Hollow shaft under torsion",
  quantity: "angle of twist θ",
  unit: "rad",
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
    supports: "z = 0 end face fixed (Ux, Uy, Uz).",
    loads: "Torque T about z as a moment on the z = L end face.",
    measured: "Mean rotation of the z = L end face about the axis.",
    source: "Gere & Goodno, Mechanics of Materials",
    note: "Quadratic elements: linear tetrahedra are too stiff in torsion with two elements through the wall.",
  },
  recipe: {
    step: () => annulusStep(ri, ro, L, "Hollow shaft"),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 10, order: 2 },
    material: APP_STEEL,
    supports: [
      { name: "Fixed end", faces: [fixedEnd], dofs: [0, 1, 2], value: 0 },
    ],
    loads: [
      {
        name: "Torque",
        kind: "moment",
        faces: [loadedEnd],
        axis: 2,
        value: T,
      },
    ],
    readout: {
      quantity: "Angle of twist",
      probe: { kind: "twist", axis: 2, faces: [loadedEnd], unit: "rad" },
      formula: "θ = T·L / (G·J)",
      reference: (T * L) / (G * J),
    },
  },
};

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Thick-walled cylinder under internal pressure, built from two tied rings.
//
//   A long cylinder (plane strain) under internal pressure p, modelled as two
//   rings with a 1 mm radial gap between them — a ≤ r ≤ c and c + g ≤ r ≤ b —
//   meshed on their own, so the nodes of the two curved facing surfaces do not
//   match and their faceted surfaces do not even run parallel. A constraint
//   (MPC) tie joins them across the gap. A quarter is modelled, with symmetry
//   supports on its cut faces and both end faces held in z.
//
// The tie makes the outer ring's bore follow the inner ring's outer surface,
// u_o(c + g) = u_i(c), and transfers the radial force, q′·(c + g) = q·c. Each
// ring then has Lamé's (1852) plane-strain solution,
//
//     u(r) = (1+ν)/E · ((1−2ν)·C₁·r + C₂/r),
//     C₁ = (pᵢ·r₁² − pₒ·r₂²)/(r₂² − r₁²),  C₂ = (pᵢ − pₒ)·r₁²·r₂²/(r₂² − r₁²),
//
// and the two conditions fix the contact pressure q: the reference is exact
// for the tied model. (Without the gap it is Lamé's single cylinder; the
// 1 mm gap, a rigid link in the tie, makes the bore displacement 1.1 %
// larger.) The measured value is the bore's radial displacement, at the
// corner of the bore and the y = 0 and z = 0 faces, a node of every mesh.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the two quarter
// rings as one STEP file, mesh them (linear tetrahedra), set the symmetry and
// end supports and the bore pressure, tie the two facing cylinders, solve, and
// read the radial displacement of the bore on the y = 0 plane.
//
// Reference: Timoshenko & Goodier, "Theory of Elasticity", thick-walled
// cylinder; M. A. Puso, IJNME 59 (2004), for curved non-matching interfaces.

import { arc, extrudedProfilesStep, line } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const a = 50, // bore radius (mm)
  c = 75, // outer radius of the inner ring (mm)
  GAP = 1, // radial gap (mm)
  b = 100, // outer radius (mm)
  t = 10; // modelled length (mm), plane strain
const p = 100; // internal pressure (MPa)
const c2 = c + GAP; // bore of the outer ring

/** Lamé's plane-strain ring r1 ≤ r ≤ r2 under pressures pi (in) and po (out). */
function ring(r1, r2, pi, po) {
  const C1 = (pi * r1 * r1 - po * r2 * r2) / (r2 * r2 - r1 * r1);
  const C2 = ((pi - po) * r1 * r1 * r2 * r2) / (r2 * r2 - r1 * r1);
  return (r) => ((1 + nu) / E) * ((1 - 2 * nu) * C1 * r + C2 / r);
}

/**
 * The tied rings' contact pressure q on the inner ring (at r = c), and the
 * bore's radial displacement: u_i(c; p, q) = u_o(c + g; q·c/(c + g), 0).
 */
export function tiedLame() {
  // Both displacements are linear in q: solve u_i(c) − u_o(c + g) = 0.
  const gapOpening = (q) =>
    ring(a, c, p, q)(c) - ring(c2, b, (q * c) / c2, 0)(c2);
  const atZero = gapOpening(0);
  const slope = gapOpening(1) - atZero;
  const q = -atZero / slope;
  return { q, bore: ring(a, c, p, q)(a) };
}

/** Lamé's single cylinder a ≤ r ≤ b, for comparison. */
export const solidBore = () => ring(a, b, p, 0)(a);

// A quarter ring r1 ≤ r ≤ r2 in the first quadrant, counter-clockwise.
const quarter = (r1, r2) => ({
  outer: [
    line([r2, 0]),
    arc([0, r2], [0, 0], true),
    line([0, r1]),
    arc([r1, 0], [0, 0], false),
  ],
  holes: [],
});

// Points a user clicks: mid-wall on the cut faces and the ends, at 45° on
// the cylinders.
const diagonal = (r, z) => [r * Math.SQRT1_2, r * Math.SQRT1_2, z];
const mid = { inner: (a + c) / 2, outer: (c2 + b) / 2 };
const face = {
  bore: { at: diagonal(a, t / 2) },
  tieA: { at: diagonal(c, t / 2) },
  tieB: { at: diagonal(c2, t / 2) },
  symmetryX: [{ at: [0, mid.inner, t / 2] }, { at: [0, mid.outer, t / 2] }],
  symmetryY: [{ at: [mid.inner, 0, t / 2] }, { at: [mid.outer, 0, t / 2] }],
  ends: [
    { at: diagonal(mid.inner, 0) },
    { at: diagonal(mid.inner, t) },
    { at: diagonal(mid.outer, 0) },
    { at: diagonal(mid.outer, t) },
  ],
};

export default {
  id: "tie-lame-cylinder",
  name: "Tied thick-walled cylinder",
  quantity: "bore radial displacement u(a)",
  unit: "mm",
  tolPct: 1,
  readout: { field: "|U|", stat: "Max" },
  page: {
    summary:
      "Internal pressure in a cylinder made of two tied rings with non-matching curved meshes.",
    model: `Quarter of a long cylinder (plane strain) in two rings, a ≤ r ≤ c and c + g ≤ r ≤ b, tied across the ${GAP} mm gap.`,
    inputs: [
      ["a", a, "mm"],
      ["c", c, "mm"],
      ["g", GAP, "mm"],
      ["b", b, "mm"],
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["p", p, "MPa"],
    ],
    supports:
      "Symmetry: Ux = 0 on the x = 0 faces, Uy = 0 on the y = 0 faces; Uz = 0 on all four end faces (plane strain).",
    loads: "Pressure p on the bore.",
    ties: "The inner ring's outer cylinder to the outer ring's bore, by constraint (MPC), whole surface.",
    measured: "Radial displacement of the bore on the y = 0 plane.",
    source: "Timoshenko & Goodier, Theory of Elasticity; Puso (2004)",
  },
  recipe: {
    step: () =>
      extrudedProfilesStep([quarter(a, c), quarter(c2, b)], t, "Tied rings"),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 4, order: 1 },
    material: APP_STEEL,
    supports: [
      { name: "Symmetry x", faces: face.symmetryX, dofs: [0], value: 0 },
      { name: "Symmetry y", faces: face.symmetryY, dofs: [1], value: 0 },
      { name: "Plane strain", faces: face.ends, dofs: [2], value: 0 },
    ],
    loads: [
      { name: "Pressure", kind: "pressure", faces: [face.bore], value: p },
    ],
    ties: [
      {
        name: "Tie1",
        facesA: [face.tieA],
        facesB: [face.tieB],
        extent: "full",
        method: "mpc",
      },
    ],
    readout: {
      quantity: "Bore radial displacement",
      probe: { kind: "displacement", component: 0, at: [a, 0, 0], unit: "mm" },
      formula: "u(a), Lamé rings tied at r = c",
      reference: tiedLame().bore,
    },
  },
};

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Scordelis–Lo roof (Scordelis and Lo 1964; MacNeal and Harder 1985, the
// shell "obstacle course").
//
//   A cylindrical roof of mid-surface radius 25, length 50 and thickness 0.25,
//   spanning 80° (40° each side of the crown), carried at both ends by rigid
//   diaphragms (held vertically and horizontally in their plane, free
//   axially and in rotation); the two straight edges are free. E = 4.32·10⁸,
//   ν = 0, and its own weight of 90 per unit area. The numbers are the
//   benchmark's in consistent units; read as metres and pascals they are, in
//   the app's units, R = 25 000 mm, L = 50 000 mm, t = 250 mm, E = 432 MPa and
//   q = 9·10⁻⁵ MPa, and the displacement comes out in mm. The roof carries the
//   load by membrane action and bending together. MacNeal and Harder
//   normalise by a vertical displacement of 0.3024 at the middle of the free
//   edge, the value converged finite element solutions approach (Scordelis
//   and Lo's deep-shell series gives 0.3086).
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import a quarter,
// θ from the crown at 0 to the free edge at 40° and z from the mid-span plane
// z = 0 to the diaphragm at z = 25 000 mm, as a 250 mm thick solid STEP file;
// mark the body Shell (the app collapses the wall to its mid-surface); hold
// the two symmetry edges and the diaphragm; put the weight on the roof face;
// solve; read the vertical displacement with a probe at the middle of the
// free edge.
//
// Why this model:
//   - MacNeal and Harder model the same quarter. The roof's vertical axis is
//     x here: the cylinder is the app's panel about z, and the crown is at
//     θ = 0. The symmetry planes y = 0 (the crown) and z = 0 (mid-span) hold
//     the displacement normal to them and the two rotations about the axes in
//     them, which the Supports card offers as Ux…Rz. The diaphragm holds Ux
//     and Uy on the edge z = 25 000 mm and leaves Uz and every rotation free.
//   - The weight is a force on the roof face: q times the mid-surface area,
//     R·(40°)·L/2, straight down (−x). The app spreads a face force as a
//     uniform traction over the face, which is what the weight is.
//
// Read-out: Ux at the middle of the free edge, (R·cos 40°, R·sin 40°, 0).

import { cylindricalPanelStep } from "../../gallery/step-revolve.mjs";
import { benchmarkMaterial } from "../lib/recipe.mjs";

const E = 432; // MPa (4.32·10⁸ Pa)
const nu = 0;
const R = 25000; // mid-surface radius (mm)
const t = 250; // thickness (mm)
const L = 50000; // length between the diaphragms (mm)
const half = 40; // half the roof's angle (degrees)
const q = 9e-5; // weight per unit area (MPa: 90 Pa)
const h = 1000; // Netgen maximum element size (mm)

const deg = Math.PI / 180;
// The weight of the quarter (N): q times its mid-surface area.
export const W = q * R * half * deg * (L / 2);
// A point on the outer cylinder at angle θ (degrees) and height z.
const outer = (theta, z) => [
  (R + t / 2) * Math.cos(theta * deg),
  (R + t / 2) * Math.sin(theta * deg),
  z,
];
const mid = (theta, z) => [
  R * Math.cos(theta * deg),
  R * Math.sin(theta * deg),
  z,
];

export default {
  id: "scordelis-lo-roof",
  name: "Scordelis–Lo roof",
  quantity: "vertical displacement at the middle of the free edge",
  unit: "mm",
  tolPct: 2,
  figure: { field: "displacement", view: [-0.6, -1, -0.7], deform: true },
  page: {
    summary:
      "The shell obstacle course's Scordelis–Lo roof: a cylindrical roof between rigid diaphragms under its own weight, from curved shells.",
    model: "A quarter of the roof as a curved shell of linear triangles.",
    inputs: [
      ["R", R, "mm"],
      ["L", L, "mm"],
      ["t", t, "mm"],
      ["φ", half, "°"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["q", q, "MPa"],
    ],
    supports:
      "Symmetry on the crown θ = 0 and at mid-span z = 0; the diaphragm edge z = L/2 held in x and y.",
    loads: "The weight q·R·φ·L/2 straight down (−x) on the roof face.",
    measured:
      "Ux at the middle of the free edge, (R·cos φ, R·sin φ, 0), read with a probe.",
    source: "MacNeal and Harder (1985), Scordelis–Lo roof",
  },
  recipe: {
    step: () => cylindricalPanelStep(R, t, L / 2, half, "Scordelis-Lo roof"),
    splits: [],
    discretization: { kind: "shell", thickness: t },
    mesh: { maxElementSize: h, order: 1 },
    material: benchmarkMaterial("Scordelis-Lo roof", E, nu),
    supports: [
      {
        name: "Symmetry at the crown",
        faces: [{ at: mid(0, L / 4) }],
        dofs: [1, 3, 5],
        value: 0,
      },
      {
        name: "Symmetry at mid-span",
        faces: [{ at: mid(half / 2, 0) }],
        dofs: [2, 3, 4],
        value: 0,
      },
      {
        name: "Diaphragm",
        faces: [{ at: mid(half / 2, L / 2) }],
        dofs: [0, 1],
        value: 0,
      },
    ],
    loads: [
      {
        name: "Weight",
        kind: "force",
        faces: [{ at: outer(half / 2, L / 4) }],
        components: [-W, 0, 0],
      },
    ],
    readout: {
      quantity: "Ux at the middle of the free edge",
      probe: {
        kind: "displacement",
        component: 0,
        at: mid(half, 0),
        unit: "mm",
      },
      formula: "MacNeal and Harder (1985)",
      reference: -302.4,
    },
  },
};

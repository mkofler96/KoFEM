// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cook's membrane, nearly incompressible (KOF-400): a published limitation.
//
//   The tapered panel of cooks-membrane.mjs, (0,0)-(48,44)-(48,60)-(0,44), in
//   plane strain with ν = 0.4999 and E = 240.565 MPa (Lamé λ ≈ 400 890 MPa,
//   μ ≈ 80.19 MPa), clamped on x = 0, a total shear F = 100 N on x = 48
//   (q = 6.25 N/mm over the 16 mm edge).
//
// Reference: the vertical displacement of the top corner C = (48, 60), 8.075
// mm (Casquero and Golestanian 2024, §5.1, the converged plane-strain value
// with E = 240.565 and ν = 0.4999 under q = 6.25).
//
// Displacement-based linear tetrahedra lock here: with λ/μ ≈ 5000 every
// element must keep its volume, and a mesh of constant-strain tetrahedra has
// almost no displacement field that does, so the panel comes out far too
// stiff. The case publishes that as an expected failure (`expectedFailure`):
// run.mjs solves the same recipe with linear tetrahedra and fails CI if their
// error leaves the recorded band, whether locking gets worse or silently goes
// away. Quadratic tetrahedra, the case's own mesh, pass the tolerance.
//
// Plane strain in KoFEM, a 3-D solver: the slab's two z faces are held in z
// (a frictionless support, Uz = 0), so every section deforms as the plane
// panel does. The read-out is Uy at C on the z = 0 face, a CAD vertex and so
// a node of every mesh.

import { prismStep } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = 240.565; // MPa
const nu = 0.4999;
const t = 1; // mm, slab thickness along z (the extrusion)
const F = 100; // N, total shear on the x = 48 face

// Points well inside each face: what a user clicks to pick it.
const clamped = { at: [0, 22, t / 2] };
const loaded = { at: [48, 52, t / 2] };
const front = { at: [24, 40, 0] };
const back = { at: [24, 40, t] };

export default {
  id: "cooks-membrane-incompressible",
  name: "Cook's membrane, nearly incompressible",
  quantity: "top-corner deflection",
  unit: "mm",
  tolPct: 1,
  readout: { field: "Uy", stat: "Max" },
  figure: { view: [-0.15, -0.1, -1] },
  // Linear tetrahedra on the case's mesh size: −43 % from the reference.
  expectedFailure: { order: 1, errPct: -43.3, bandPct: 2 },
  page: {
    summary:
      "Rubber-like material in plane strain: linear tetrahedra lock, quadratic tetrahedra get the answer.",
    model:
      "Trapezoid (0, 0)–(48, 44)–(48, 60)–(0, 44), extruded by t, in plane strain.",
    inputs: [
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["F", F, "N"],
    ],
    supports:
      "x = 0 face fixed (Ux, Uy, Uz); both z faces held in z (Uz), for plane strain.",
    loads: "F in +y as one force on the x = 48 face.",
    measured:
      "y-displacement at C (48, 60, 0), the top corner of the loaded edge.",
    source: "Casquero and Golestanian (2024), §5.1",
  },
  recipe: {
    step: () =>
      prismStep(
        [
          [0, 0],
          [48, 44],
          [48, 60],
          [0, 44],
        ],
        t,
        "Cook's membrane",
      ),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 2, order: 2 },
    // E and ν as the benchmark sets them; the density is the material form's
    // default (it does not enter a static solve).
    material: {
      name: "Nearly incompressible",
      young: E,
      poisson: nu,
      density: APP_STEEL.density,
    },
    supports: [
      { name: "Clamp", faces: [clamped], dofs: [0, 1, 2], value: 0 },
      { name: "Plane strain", faces: [front, back], dofs: [2], value: 0 },
    ],
    loads: [
      {
        name: "Shear",
        kind: "force",
        faces: [loaded],
        components: [0, F, 0],
      },
    ],
    readout: {
      quantity: "Deflection at C",
      probe: {
        kind: "displacement",
        component: 1,
        at: [48, 60, 0],
        unit: "mm",
      },
      formula: "converged plane-strain value",
      reference: 8.075,
    },
  },
};

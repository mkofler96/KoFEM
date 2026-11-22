// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// NAFEMS LE1 — elliptic membrane (The Standard NAFEMS Benchmarks, TNSB Rev. 3,
// 1990).
//
//   A quarter of an elliptic ring, x, y ≥ 0, between the inner ellipse
//   (x/2000)² + (y/1000)² = 1 and the outer ellipse (x/3250)² + (y/2750)² = 1
//   (mm), 100 mm thick, in plane stress. Steel, E = 210 GPa, ν = 0.3. The
//   outer edge BC carries a uniform outward pressure of 10 MPa; the edge AB
//   (x = 0) is held in x and the edge CD (y = 0) in y. NAFEMS gives the
//   tangential stress σyy = 92.7 MPa at D = (2000, 0), where the inner
//   ellipse is sharpest.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the quarter as
// a STEP file of half the thickness, 0 ≤ z ≤ 50 mm, mesh it with quadratic
// tetrahedra, hold the three cut faces, pull the outer face, solve, and read
// σyy with a probe at D.
//
// Why this model:
//   - Plane stress as a thin solid: the faces z = ±50 mm are free, and the
//     stress through the 100 mm thickness is the plane-stress state up to a
//     small 3D effect at D. The model keeps the half 0 ≤ z ≤ 50 and holds Uz
//     on its mid-plane z = 0, which is exact by symmetry and stops the plate
//     from moving out of plane.
//   - Quadratic tetrahedra: a stress concentration needs a stress that varies
//     inside the element. NAFEMS' coarse meshes of linear triangles read up to
//     45 % low.
//   - The outward pressure is −10 MPa in the app, whose pressure pushes along
//     the inward normal.
//
// Read-out: σyy at D on the mid-plane, z = 0, as a probe placed there by its
// coordinates reads it: each element's stress at its corner D, averaged over
// the elements that meet there.
//
// Tolerance: 3 %. The corner stresses of the few elements at D scatter around
// the peak, so the read-out lands 1–2 % high on meshes of 100 and 50 mm and
// settles to a few tenths of a percent at 25 mm (the page's convergence
// study).

import { ellipticMembraneStep } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const t = 100; // thickness (mm); the model keeps half of it
const p = 10; // outward pressure on the outer edge (MPa)
const h = 50; // Netgen maximum element size (mm)

const D = [2000, 0, 0];

export default {
  id: "nafems-le1",
  name: "NAFEMS LE1: elliptic membrane",
  quantity: "tangential stress σyy at D",
  unit: "MPa",
  tolPct: 3,
  figure: {
    field: "vonMises",
    view: [0, 0, -1],
    deform: false,
  },
  page: {
    summary:
      "The NAFEMS elliptic membrane in plane stress: σyy = 92.7 MPa at the sharp end of the inner ellipse, from quadratic tetrahedra.",
    model:
      "Quarter of the elliptic ring, half its thickness, quadratic tetrahedra.",
    inputs: [
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["p", p, "MPa"],
    ],
    supports:
      "Ux on the face x = 0, Uy on the face y = 0, Uz on the mid-plane z = 0.",
    loads: "10 MPa outward pressure on the outer elliptic face.",
    measured: "σyy at D = (2000, 0, 0) mm, read with a probe.",
    source: "NAFEMS TNSB Rev. 3 (1990), test LE1",
  },
  recipe: {
    step: () => ellipticMembraneStep(t / 2, "NAFEMS LE1 elliptic membrane"),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: h, order: 2 },
    material: APP_STEEL,
    supports: [
      {
        name: "Symmetry x = 0",
        faces: [{ at: [0, 1800, 10] }],
        dofs: [0],
        value: 0,
      },
      {
        name: "Symmetry y = 0",
        faces: [{ at: [2600, 0, 10] }],
        dofs: [1],
        value: 0,
      },
      {
        name: "Mid-plane z = 0",
        faces: [{ at: [1000, 1500, 0] }],
        dofs: [2],
        value: 0,
      },
    ],
    loads: [
      {
        name: "Outward pressure",
        kind: "pressure",
        // A point on the outer ellipse at 45° of its parameter.
        faces: [{ at: [3250 * Math.SQRT1_2, 2750 * Math.SQRT1_2, 10] }],
        value: -p,
      },
    ],
    readout: {
      quantity: "Tangential stress at D",
      probe: { kind: "stress", field: "Normal stress σyy", at: D, unit: "MPa" },
      formula: "NAFEMS LE1 target",
      reference: 92.7,
    },
  },
};

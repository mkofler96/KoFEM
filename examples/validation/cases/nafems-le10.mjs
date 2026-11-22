// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// NAFEMS LE10 — thick plate under pressure (The Standard NAFEMS Benchmarks,
// TNSB Rev. 3, 1990).
//
//   The planform of LE1, a quarter of an elliptic ring between the inner
//   ellipse (x/2000)² + (y/1000)² = 1 and the outer ellipse
//   (x/3250)² + (y/2750)² = 1 (mm), 600 mm thick. Steel, E = 210 GPa,
//   ν = 0.3. A uniform pressure of 1 MPa acts on the upper face. The face
//   y = 0 is held in y, the face x = 0 in x, the outer curved face in x and
//   y, and the mid-height line EE′ of the outer face in z. NAFEMS gives the
//   direct stress σyy = −5.38 MPa at D, on the upper face where the inner
//   ellipse meets y = 0.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the plate as a
// STEP file, 0 ≤ z ≤ 600 mm, cut a 20 mm band around mid-height out of the
// outer face with two splits, mesh with quadratic tetrahedra, apply the
// supports and the pressure, solve, and read σyy with a probe at D.
//
// Why this model:
//   - The line support EE′ becomes the band 290 ≤ z ≤ 310 mm held in z:
//     every support in KoFEM sits on whole CAD faces. The band is 1/30 of the
//     thickness and 1.25 m from D, so it holds the plate up as the line does.
//   - Quadratic tetrahedra, as the bending of a thick plate needs.
//
// Read-out: σyy at D = (2000, 0, 600), as a probe placed there by its
// coordinates reads it.
//
// Read-out: each element's stress at its corner D, averaged over the elements
// that meet there. Read at the element centres instead, the stress would lie
// below the upper face and read 10–20 % low.
//
// Tolerance: 2 %. The read-out is within half a percent on meshes from 150 to
// 75 mm (the page's convergence study).

import { ellipticMembraneStep } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const t = 600; // thickness (mm)
const p = 1; // pressure on the upper face (MPa)
const band = 20; // height of the band that stands in for the line EE′ (mm)
const h = 150; // Netgen maximum element size (mm)

// A point on the outer ellipse at 45° of its parameter, at height z.
const outer = (z) => [3250 * Math.SQRT1_2, 2750 * Math.SQRT1_2, z];

export default {
  id: "nafems-le10",
  name: "NAFEMS LE10: thick plate under pressure",
  quantity: "direct stress σyy at D",
  unit: "MPa",
  tolPct: 2,
  figure: {
    field: "vonMises",
    view: [-1, -1.2, -0.8],
    deform: true,
  },
  page: {
    summary:
      "The NAFEMS thick elliptic plate under pressure: σyy = −5.38 MPa on the upper face at D, from quadratic tetrahedra.",
    model:
      "Quarter of the elliptic plate, full thickness, quadratic tetrahedra; the line support EE′ as a 20 mm band.",
    inputs: [
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["p", p, "MPa"],
    ],
    supports:
      "Uy on the face y = 0, Ux on the face x = 0, Ux and Uy on the outer face, Uz on a 20 mm band at mid-height of the outer face.",
    loads: "1 MPa pressure on the upper face.",
    measured: "σyy at D = (2000, 0, 600) mm, read with a probe.",
    source: "NAFEMS TNSB Rev. 3 (1990), test LE10",
  },
  recipe: {
    step: () => ellipticMembraneStep(t, "NAFEMS LE10 thick plate"),
    splits: [
      {
        mode: "faces",
        faces: [{ at: outer(t / 4) }],
        origin: [0, 0, (t - band) / 2],
        normal: [0, 0, 1],
      },
      {
        mode: "faces",
        faces: [{ at: outer((3 * t) / 4) }],
        origin: [0, 0, (t + band) / 2],
        normal: [0, 0, 1],
      },
    ],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: h, order: 2 },
    material: APP_STEEL,
    supports: [
      { name: "Symmetry y = 0", faces: [{ at: [2600, 0, 100] }], dofs: [1], value: 0 },
      { name: "Symmetry x = 0", faces: [{ at: [0, 1800, 100] }], dofs: [0], value: 0 },
      {
        name: "Outer face",
        faces: [
          { at: outer(t / 4) },
          { at: outer(t / 2) },
          { at: outer((3 * t) / 4) },
        ],
        dofs: [0, 1],
        value: 0,
      },
      { name: "Line EE′", faces: [{ at: outer(t / 2) }], dofs: [2], value: 0 },
    ],
    loads: [
      {
        name: "Pressure",
        kind: "pressure",
        faces: [{ at: [1500, 1500, t] }],
        value: p,
      },
    ],
    readout: {
      quantity: "Direct stress at D",
      probe: {
        kind: "stress",
        field: "Normal stress σyy",
        at: [2000, 0, t],
        unit: "MPa",
      },
      formula: "NAFEMS LE10 target",
      reference: -5.38,
    },
  },
};

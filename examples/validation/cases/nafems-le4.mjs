// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// NAFEMS LE4 — hyperbolic shell of revolution under internal pressure (The
// Standard NAFEMS Benchmarks, TNSB Rev. 3, 1990).
//
//   A hyperboloid of one sheet, mid-surface r² − z² = 1000² (mm), from its
//   waist (r = 1000 mm, z = 0) to the top edge at z = 1000 mm (r = √2·1000),
//   10 mm thick; NAFEMS models it as an axisymmetric shell that is symmetric
//   about the waist plane. Steel, E = 210 GPa, ν = 0.3. A uniform internal
//   pressure of 1 MPa; the top edge is free. NAFEMS gives the mid-surface
//   stresses at K, on the waist: meridional σφφ = −50 MPa and hoop
//   σθθ = +50 MPa (membrane theory: the waist carries the axial pull of the
//   pressure on the flaring wall above it, N_φ = −p·(r_top² − r_K²)/(2·r_K)).
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import a 90° sector
// of the upper half as a 10 mm thick solid STEP file, mark it Shell (the app
// collapses the curved wall to its mid-surface), put symmetry supports on the
// two meridian edges and on the waist edge, press the wall from inside,
// solve, and read σzz on the mid-surface with a probe at K.
//
// Why this model:
//   - A quarter of the upper half, with three symmetry planes: θ = 0 holds
//     Uy, Rx, Rz; θ = 90° holds Ux, Ry, Rz; the waist z = 0 holds Uz, Rx, Ry.
//     Together they stop every rigid motion, so the free top edge needs no
//     support.
//   - The wall's faces are the mid-surface offset by ±5 mm along its normal
//     (no hyperboloid is an offset of one), so the app measures a 10 mm wall.
//   - The internal pressure is −1 MPa on the outer face, the face the shell
//     keeps: the app presses along the face's inward normal, and the shell
//     carries a pressure on either face of the wall.
//
// Read-out: σzz on the mid-surface at K = (1000, 0, 0). The meridian is
// vertical at the waist, so σzz there is the meridional stress; σyy at K is
// the hoop stress.
//
// Tolerance: 3 %. σzz reads −50.30, −50.07 and −50.03 MPa on meshes of 50,
// 25 and 12.5 mm (2 000 to 29 000 triangles): within 0.6 % throughout.

import { hyperboloidShellStep } from "../../gallery/step-revolve.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const a = 1000; // waist radius of the mid-surface r² − z² = a² (mm)
const H = 1000; // height of the top edge above the waist (mm)
const t = 10; // thickness (mm)
const p = 1; // internal pressure (MPa)
const h = 50; // Netgen maximum element size (mm)

const deg = Math.PI / 180;
// Mid-surface radius at height z.
const rMid = (z) => Math.sqrt(a * a + z * z);
// A point on the mid-surface at angle θ (degrees) and height z.
const mid = (theta, z) => [
  rMid(z) * Math.cos(theta * deg),
  rMid(z) * Math.sin(theta * deg),
  z,
];
// The point t/2 out of the mid-surface point at θ, z, along its normal
// (r, −z)/|…|: on the outer face.
const outer = (theta, z) => {
  const r = rMid(z) + ((t / 2) * rMid(z)) / Math.hypot(rMid(z), z);
  return [
    r * Math.cos(theta * deg),
    r * Math.sin(theta * deg),
    z - ((t / 2) * z) / Math.hypot(rMid(z), z),
  ];
};

export default {
  id: "nafems-le4",
  name: "NAFEMS LE4: hyperbolic shell",
  quantity: "meridional stress at K, mid-surface",
  unit: "MPa",
  tolPct: 3,
  figure: { field: "vonMises", view: [-1, -0.6, -0.4], deform: true },
  page: {
    summary:
      "The NAFEMS hyperbolic shell of revolution under internal pressure: σ = −50 MPa meridional at the waist, from curved shells.",
    model:
      "A 90° sector of the upper half as a curved shell of linear triangles.",
    inputs: [
      ["a", a, "mm"],
      ["H", H, "mm"],
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["p", p, "MPa"],
    ],
    supports:
      "Symmetry on the edges θ = 0 and θ = 90° and on the waist z = 0; the top edge free.",
    loads: "1 MPa pressure on the inner face.",
    measured:
      "σzz on the mid-surface at K = (1000, 0, 0) mm, read with a probe: the meridional stress.",
    source: "NAFEMS TNSB Rev. 3 (1990), test LE4",
  },
  recipe: {
    step: () =>
      hyperboloidShellStep(a, a, H, t, 90, "NAFEMS LE4 hyperbolic shell"),
    splits: [],
    discretization: { kind: "shell", thickness: t },
    mesh: { maxElementSize: h, order: 1 },
    material: APP_STEEL,
    supports: [
      {
        name: "Symmetry z = 0 (waist)",
        faces: [{ at: mid(45, 0) }],
        dofs: [2, 3, 4],
        value: 0,
      },
      {
        name: "Symmetry y = 0",
        faces: [{ at: mid(0, H / 2) }],
        dofs: [1, 3, 5],
        value: 0,
      },
      {
        name: "Symmetry x = 0",
        faces: [{ at: mid(90, H / 2) }],
        dofs: [0, 4, 5],
        value: 0,
      },
    ],
    loads: [
      {
        name: "Internal pressure",
        kind: "pressure",
        faces: [{ at: outer(45, H / 2) }],
        value: -p,
      },
    ],
    readout: {
      quantity: "Meridional stress at K",
      probe: {
        kind: "stress",
        field: "Normal stress σzz",
        surface: "middle",
        at: [a, 0, 0],
        unit: "MPa",
      },
      formula: "NAFEMS LE4 target",
      reference: -50,
    },
  },
};

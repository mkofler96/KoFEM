// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The axial bar compressed by a uniform pressure on its end face.
//
//   Pressure acts along the inward normal, so a positive p shortens the bar:
//   u(L) = −p·L/E, independent of the cross-section. Checks the sign of
//   pressure loads and that p is a force per area, not a total force.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the bar as a
// STEP file, mesh it with Netgen (linear tetrahedra, 25 mm), fix the x = 0
// face, put a pressure on the x = L face, solve, and read the mean
// x-displacement of the loaded face in the Results panel's hand check. Same
// bar and mesh as axial-bar, so the two errors must match.
//
// Reference: any mechanics-of-materials text (e.g. Gere & Goodno, "Mechanics of
// Materials", axially loaded members).

import { prismStep } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const L = 1000; // mm, along x
const W = 100, // mm, along z (the extrusion)
  H = 100; // mm, along y
const p = 1.0; // pressure (MPa) on the x = L face

// A point in the middle of each end face: what a user clicks to pick it.
const fixedEnd = { at: [0, H / 2, W / 2] };
const loadedEnd = { at: [L, H / 2, W / 2] };

export default {
  id: "surface-pressure",
  name: "Bar under end pressure",
  quantity: "tip displacement u",
  unit: "mm",
  tolPct: 2,
  readout: { field: "Ux", stat: "Min" },
  page: {
    summary:
      "The bar pushed by a pressure. Checks the sign and the per-area scaling of pressure loads.",
    model: "Prismatic bar of length L along x, W × H section.",
    inputs: [
      ["L", L, "mm"],
      ["W × H", `${W} × ${H}`, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["p", p, "MPa"],
    ],
    supports: "x = 0 face fixed (Ux, Uy, Uz).",
    loads: "Pressure p on the x = L face.",
    measured: "Mean x-displacement of the x = L face.",
    source: "Gere & Goodno, Mechanics of Materials",
  },
  recipe: {
    step: () =>
      prismStep(
        [
          [0, 0],
          [L, 0],
          [L, H],
          [0, H],
        ],
        W,
        "Pressure bar",
      ),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 25, order: 1 },
    material: APP_STEEL,
    supports: [
      { name: "Fixed end", faces: [fixedEnd], dofs: [0, 1, 2], value: 0 },
    ],
    loads: [
      { name: "End pressure", kind: "pressure", faces: [loadedEnd], value: p },
    ],
    readout: {
      quantity: "Tip displacement",
      probe: {
        kind: "displacement",
        component: 0,
        faces: [loadedEnd],
        unit: "mm",
      },
      formula: "u = −p·L / E",
      reference: -(p * L) / E,
    },
  },
};

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Axial bar in uniaxial tension — the simplest sanity benchmark.
//
//   A prismatic bar, fixed at x=0, pulled by a total axial force P over the x=L
//   face, applied as the app applies a force to a face: a uniform traction
//   integrated into work-equivalent nodal forces. Closed-form tip extension:
//   δ = P·L / (E·A).
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the bar as a
// STEP file, mesh it with Netgen (linear tetrahedra, 25 mm), fix the x = 0
// face, pull the x = L face, solve, and read the mean x-displacement of the
// loaded face in the Results panel's hand check.
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
const P = 1.0e6; // total axial force (N)

// A point in the middle of each end face: what a user clicks to pick it.
const fixedEnd = { at: [0, H / 2, W / 2] };
const loadedEnd = { at: [L, H / 2, W / 2] };

export default {
  id: "axial-bar",
  name: "Axial bar in tension",
  quantity: "tip extension δ",
  unit: "mm",
  tolPct: 2,
  readout: { field: "Ux", stat: "Max" },
  page: {
    summary:
      "Uniform tension. Checks material, supports and how a face load reaches the nodes.",
    model: "Prismatic bar of length L along x, W × H section.",
    inputs: [
      ["L", L, "mm"],
      ["W × H", `${W} × ${H}`, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["P", P, "N"],
    ],
    supports: "x = 0 face fixed (Ux, Uy, Uz).",
    loads: "P in +x as a force on the x = L face.",
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
        "Axial bar",
      ),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 25, order: 1 },
    material: APP_STEEL,
    supports: [
      { name: "Fixed end", faces: [fixedEnd], dofs: [0, 1, 2], value: 0 },
    ],
    loads: [
      {
        name: "Axial load",
        kind: "force",
        faces: [loadedEnd],
        components: [P, 0, 0],
      },
    ],
    readout: {
      quantity: "Tip extension",
      probe: {
        kind: "displacement",
        component: 0,
        faces: [loadedEnd],
        unit: "mm",
      },
      formula: "δ = P·L / (E·A)",
      reference: (P * L) / (E * (W * H)),
    },
  },
};

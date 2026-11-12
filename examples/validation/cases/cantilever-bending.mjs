// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cantilever beam with an end load — Euler–Bernoulli bending, linear
// tetrahedra.
//
//   Beam of span L along x, b × h section, clamped at x=0, transverse load P
//   (−y) on the free end face x=L. Tip deflection  δ = −P·L³ / (3·E·I),
//   I = b·h³/12.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the block as a
// STEP file, mesh it with Netgen, fix the x = 0 face, load the x = L face,
// solve, and read the mean y-displacement of the loaded face in the Results
// panel's hand check. The three cantilever examples are this one model; only
// the mesh changes (cantileverRecipe below):
//
//   cantilever       linear tetrahedra, 12.5 mm (this file)
//   cantilever-p2    quadratic tetrahedra, 50 mm (cantilever-bending-p2.mjs)
//   cantilever-beam  quadratic tetrahedra, 25 mm (cantilever-beam.mjs)
//
// Linear tetrahedra lock in bending: they are far too stiff on coarse meshes
// and converge from below (convergence.mjs; with the engine build of KOF-322:
// −27 % at 50 mm, −15 % at 25 mm, −3.9 % at 12.5 mm, −1.3 % at 8 mm). The
// 12.5 mm mesh, eight elements through the depth, is the coarsest on which
// they come within a few percent; the 5 % band holds that remaining
// discretisation error, which the page states and the study shows shrinking.
// It is a band for linear elements in bending, not a claim that they are
// accurate there; quadratic elements on the same block converge to within
// 0.1 % of the reference.
//
// Reference: Euler–Bernoulli beam theory (Gere & Goodno, deflections of beams).

import { prismStep } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const L = 1000; // mm, along x
const h = 100, // mm, depth along y (the load direction)
  b = 100; // mm, width along z (the extrusion)
const P = 1.0e4; // tip load (N), downward

const I = (b * h ** 3) / 12;

// A point in the middle of each end face: what a user clicks to pick it.
const clampedEnd = { at: [0, h / 2, b / 2] };
const loadedEnd = { at: [L, h / 2, b / 2] };

export const cantileverInputs = [
  ["L", L, "mm"],
  ["b × h", `${b} × ${h}`, "mm"],
  ["E", E, "MPa"],
  ["ν", nu, ""],
  ["P", P, "N"],
];

/** What every cantilever page says about the model. */
export const cantileverPage = {
  model: "Beam of span L along x, b × h section, I = b·h³/12.",
  inputs: cantileverInputs,
  supports: "x = 0 face fixed (Ux, Uy, Uz).",
  loads: "P in −y as a force on the x = L face.",
  measured: "Mean y-displacement of the x = L face.",
  source: "Euler–Bernoulli beam theory",
};

/** The cantilever recipe on a Netgen mesh of `maxElementSize` mm at `order`. */
export function cantileverRecipe({ maxElementSize, order }) {
  return {
    step: () =>
      prismStep(
        [
          [0, 0],
          [L, 0],
          [L, h],
          [0, h],
        ],
        b,
        "Cantilever beam",
      ),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize, order },
    material: APP_STEEL,
    supports: [
      { name: "Clamped end", faces: [clampedEnd], dofs: [0, 1, 2], value: 0 },
    ],
    loads: [
      {
        name: "Tip load",
        kind: "force",
        faces: [loadedEnd],
        components: [0, -P, 0],
      },
    ],
    readout: {
      quantity: "Tip deflection",
      probe: {
        kind: "displacement",
        component: 1,
        faces: [loadedEnd],
        unit: "mm",
      },
      formula: "−P·L³ / (3·E·I)",
      reference: -(P * L ** 3) / (3 * E * I),
    },
  };
}

export default {
  id: "cantilever",
  name: "Cantilever beam, linear tetrahedra",
  quantity: "tip deflection δ",
  unit: "mm",
  // Linear tetrahedra at 12.5 mm are ~4 % too stiff (shear locking); the band
  // holds that known discretisation error (see the header).
  tolPct: 5,
  readout: { field: "Uy", stat: "Min" },
  page: {
    ...cantileverPage,
    summary:
      "Bending with linear elements, which are too stiff in bending (shear locking).",
  },
  recipe: cantileverRecipe({ maxElementSize: 12.5, order: 1 }),
};

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cantilever beam with an end load — Euler–Bernoulli bending, quadratic
// tetrahedra.
//
//   Beam of span L along x, b × h section, clamped at x=0, transverse load P
//   (−y) on the free end face x=L. Tip deflection  δ = −P·L³ / (3·E·I),
//   I = b·h³/12.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the block as a
// STEP file, mesh it with Netgen (25 mm, about four elements through the
// depth, quadratic tetrahedra), fix the x = 0 face, load the x = L face, solve,
// and read the mean y-displacement of the loaded face in the Results panel's
// hand check. The analysis file opens unsolved on the static study, and the
// app's tests open it (?example=cantilever-beam) as the standard
// solved-in-seconds model.
//
// Quadratic, because linear tetrahedra lock in bending: far too stiff on
// coarse meshes, they converge from below (−15 % at 25 mm, −3.9 % at 12.5 mm).
// The page's convergence study (convergence.mjs) solves this recipe with both
// orders; the quadratic series settles within 0.1 % of the reference, and at
// 25 mm the result sits about 0.1 % from that converged value. The 1 % band
// holds this discretisation error.
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

const inputs = [
  ["L", L, "mm"],
  ["b × h", `${b} × ${h}`, "mm"],
  ["E", E, "MPa"],
  ["ν", nu, ""],
  ["P", P, "N"],
];

const page = {
  model: "Beam of span L along x, b × h section, I = b·h³/12.",
  inputs,
  supports: "x = 0 face fixed (Ux, Uy, Uz).",
  loads: "P in −y as a force on the x = L face.",
  measured: "Mean y-displacement of the x = L face.",
  source: "Euler–Bernoulli beam theory",
};

export default {
  id: "cantilever-beam",
  name: "Cantilever beam under tip load",
  quantity: "tip deflection δ",
  unit: "mm",
  tolPct: 1,
  readout: { field: "Uy", stat: "Min" },
  page: {
    ...page,
    summary:
      "Bending on quadratic elements; linear ones lock and are far too stiff.",
  },
  recipe: {
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
    mesh: { maxElementSize: 25, order: 2 },
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
  },
};

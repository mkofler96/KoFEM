// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A cantilever beam in two tied halves, quadratic tetrahedra.
//
//   The cantilever of cantilever-beam.mjs — span L along x, b × h section,
//   clamped at x = 0, tip load P (−y) — cut at mid-span into two bodies 2 mm
//   apart, meshed on their own and joined by a constraint (MPC) tie. (A gap
//   below the app's face-pick tolerance, a thousandth of the model size,
//   would let one click name both facing faces.)
//
// Unlike the patch test, bending is not a linear field: the tie has to carry a
// shear force and a bending moment across faces whose nodes do not match, with
// quadratic elements on both sides (on quadratic elements the tied nodes follow
// the master face's quadratic field). The tie bridges the gap rigidly, so by
// Euler–Bernoulli theory the beam is one of length L + g whose segment
// L/2 ≤ x ≤ L/2 + g does not bend:
//
//     δ = P / (3·E·I) · ((L + g)³ − (L/2 + g)³ + (L/2)³),   I = b·h³/12,
//
// which the 2 mm gap makes 0.45 % larger than the uncut beam's P·L³/(3·E·I).
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the two halves
// as one STEP file, mesh them (25 mm, quadratic tetrahedra), clamp the x = 0
// face, load the far end face, tie the two facing faces, solve, and read the
// mean y-displacement of the loaded face.
//
// Reference: Euler–Bernoulli beam theory (Gere & Goodno, deflections of beams).

import { extrudedProfilesStep, line } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const L = 1000, // mm, span without the gap
  GAP = 2, // mm between the halves
  h = 100, // mm, depth along y (the load direction)
  b = 100; // mm, width along z (the extrusion)
const P = 1.0e4; // tip load (N), downward

const I = (b * h ** 3) / 12;
const half = L / 2;
const END = L + GAP;

const block = (x0, x1) => ({
  outer: [line([x1, 0]), line([x1, h]), line([x0, h]), line([x0, 0])],
  holes: [],
});

const face = {
  clamped: { at: [0, h / 2, b / 2] },
  loaded: { at: [END, h / 2, b / 2] },
  tieA: { at: [half, h / 2, b / 2] },
  tieB: { at: [half + GAP, h / 2, b / 2] },
};

const deflection =
  (P * ((L + GAP) ** 3 - (half + GAP) ** 3 + half ** 3)) / (3 * E * I);

export default {
  id: "tie-cantilever",
  name: "Tied cantilever beam",
  quantity: "tip deflection δ",
  unit: "mm",
  tolPct: 1,
  readout: { field: "Uy", stat: "Min" },
  page: {
    summary:
      "Bending across a tie between non-matching quadratic meshes, at mid-span.",
    model: `Beam of span L along x, b × h section, cut at mid-span into two bodies ${GAP} mm apart and tied; I = b·h³/12.`,
    inputs: [
      ["L", L, "mm"],
      ["g", GAP, "mm"],
      ["b × h", `${b} × ${h}`, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["P", P, "N"],
    ],
    supports: "x = 0 face fixed (Ux, Uy, Uz).",
    loads: "P in −y as a force on the far end face.",
    ties: "The two faces at mid-span, by constraint (MPC), whole surface.",
    measured: "Mean y-displacement of the loaded end face.",
    source: "Euler–Bernoulli beam theory",
  },
  recipe: {
    step: () =>
      extrudedProfilesStep(
        [block(0, half), block(half + GAP, END)],
        b,
        "Tied cantilever",
      ),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 25, order: 2 },
    material: APP_STEEL,
    supports: [
      { name: "Clamp", faces: [face.clamped], dofs: [0, 1, 2], value: 0 },
    ],
    loads: [
      {
        name: "Tip load",
        kind: "force",
        faces: [face.loaded],
        components: [0, -P, 0],
      },
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
      quantity: "Tip deflection",
      probe: {
        kind: "displacement",
        component: 1,
        faces: [face.loaded],
        unit: "mm",
      },
      formula: "−P/(3·E·I)·((L+g)³ − (L/2+g)³ + (L/2)³)",
      reference: -deflection,
    },
  },
};

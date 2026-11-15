// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Square beam under torsion — Saint-Venant torsion of a non-circular section.
//
//   Beam of length L along x, square b × b section, clamped at x=0, torque T
//   about the beam axis on the free end face. Angle of twist θ = T·L / (G·K),
//   G = E/(2(1+ν)), K = β·b⁴ with Roark's square-section constant
//   β = 1/3 − 0.21·(1 − 1/12) ≈ 0.1408.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the beam as a
// STEP file, mesh it with Netgen, clamp the x = 0 face, put a moment about x
// on the x = L face, solve, and read the twist of the end face in the Results
// panel's hand check (mean (r × u)_x / r² about the face's node centroid).
//
// The app turns the moment into tangential nodal forces ∝ r about the face's
// node centroid (momentToNodalForces), one point force per vertex of the
// face's surface mesh.
//
// Mesh: quadratic tetrahedra, 12.5 mm. Linear tetrahedra lock in torsion
// (θ 27 % low at 25 mm, 8 % at 12.5 mm, 2.4 % at 6.25 mm). Quadratic ones are
// within 1.5 % of the reference from 50 mm down and settle towards it from
// above (25 mm +1.4 %, 12.5 mm +0.74 %, 10 mm +0.48 %, 8 mm +0.34 %).
// Sections inside the bar rotate within a few tenths of a percent of
// T·x / (G·K) on every quadratic mesh from 25 mm down; the excess sits on the
// loaded face itself, which the vertex point forces deform locally, and it
// shrinks with the mesh. The 5 % band covers that, Roark's fit for β (0.17 %
// above the series value 0.1406, so the reference is that much low) and the
// clamp, which holds the x = 0 section flat — a small effect, since a square
// section warps little. 12.5 mm rather than 25 mm because it is nearer the
// converged value and still solves in seconds.
//
// Reference: Timoshenko & Goodier, "Theory of Elasticity"; Roark's Formulas.

import { prismStep } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const G = E / (2 * (1 + nu));
const L = 1000; // mm, along x
const b = 100; // square side (mm), along y and z
const T = 1.0e6; // N·mm about x

const beta = 1 / 3 - 0.21 * (1 - 1 / 12); // square-section (b/a = 1) constant
const K = beta * b ** 4;

// A point in the middle of each end face: what a user clicks to pick it.
const clampedEnd = { at: [0, b / 2, b / 2] };
const freeEnd = { at: [L, b / 2, b / 2] };

export default {
  id: "beam-torsion",
  name: "Square beam under torsion",
  quantity: "angle of twist θ",
  unit: "rad",
  tolPct: 5,
  page: {
    summary:
      "Torsion of a square section, which warps. The clamp holds the warping back.",
    model:
      "Beam of length L along x, square b × b section; K = β·b⁴, β = 1/3 − 0.21·(1 − 1/12).",
    inputs: [
      ["L", L, "mm"],
      ["b", b, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["T", T, "N·mm"],
    ],
    supports: "x = 0 face fixed (Ux, Uy, Uz).",
    loads: "Torque T about x as a moment on the x = L face.",
    measured: "Mean rotation of the x = L face about its centre.",
    source: "Timoshenko & Goodier, Theory of Elasticity; Roark",
  },
  recipe: {
    step: () =>
      prismStep(
        [
          [0, 0],
          [L, 0],
          [L, b],
          [0, b],
        ],
        b,
        "Torsion beam",
      ),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 12.5, order: 2 },
    material: APP_STEEL,
    supports: [
      { name: "Clamped end", faces: [clampedEnd], dofs: [0, 1, 2], value: 0 },
    ],
    loads: [
      { name: "Torque", kind: "moment", faces: [freeEnd], axis: 0, value: T },
    ],
    readout: {
      quantity: "Angle of twist",
      probe: { kind: "twist", axis: 0, faces: [freeEnd], unit: "rad" },
      formula: "θ = T·L / (G·K)",
      reference: (T * L) / (G * K),
    },
  },
};

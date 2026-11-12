// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The MBB beam's recipe (KOF-322): how a user builds the topology-optimization
// example in the GUI from one STEP file. generate-mbb-topopt.mjs builds the
// example from it (lib/pipeline.mjs), and web/tests/examples-by-hand.spec.ts
// walks it with real clicks.
//
//   1. Import mbb-beam-topopt.step: a plain 300 × 50 × 10 mm block, six faces.
//   2. Split faces with planes x = c, so that the supports and the load sit on
//      their own CAD faces: the bottom face at x = 5, then its long piece at
//      x = 295 (the pin and roller pads); the top face at x = 145, then its
//      right piece at x = 155 (the 10 mm load pad). Each split's face is named
//      by a point on the piece it cuts, after the splits before it.
//   3. Mesh with a 5 mm max element size, linear tetrahedra.
//   4. Supports: the left pad Ux Uy Uz, the right pad Uy only (a roller).
//      Load: Fy = −1000 N on the mid-span pad.
//   5. Optimize: minimum compliance, volume fraction 0.5, p = 3, r_min = 10 mm,
//      move limit 0.2, at most 100 iterations, tolerance 0.01.
//
// The read-out is the final compliance the Results panel shows after the run.
// It has no closed form; the page publishes the app's own converged value.

import { prismStep } from "../step-prism.mjs";
import { APP_STEEL } from "../../validation/lib/recipe.mjs";

export const L = 300; // span (mm)
export const H = 50; // height (mm)
export const T = 10; // thickness (mm)
export const PAD = 5; // width of each support pad (mm)
export const LOAD_PAD = 10; // width of the load pad at mid-span (mm)
export const F = 1000; // central load (N), downward

// Mid-thickness points on each face a step names.
const z = T / 2;
const bottom = (x) => ({ at: [x, 0, z] });
const top = (x) => ({ at: [x, H, z] });
const pinPad = bottom(PAD / 2);
const rollerPad = bottom(L - PAD / 2);
const loadPad = top(L / 2);
const cutAtX = (face, x) => ({
  mode: "faces",
  faces: [face],
  origin: [x, 0, 0],
  normal: [1, 0, 0],
});

export default {
  step: () =>
    prismStep(
      [
        [0, 0],
        [L, 0],
        [L, H],
        [0, H],
      ],
      T,
      "MBB beam",
    ),
  splits: [
    cutAtX(bottom(L / 2), PAD), // the whole bottom face
    cutAtX(bottom(L / 2), L - PAD), // its piece x ∈ [5, 300]
    cutAtX(top(L / 3), L / 2 - LOAD_PAD / 2), // the whole top face
    cutAtX(top((2 * L) / 3), L / 2 + LOAD_PAD / 2), // its piece x ∈ [145, 300]
  ],
  discretization: { kind: "solid" },
  // Two tetrahedra through the thickness, ~8k elements: about half a second
  // per optimizer iteration in the browser.
  mesh: { maxElementSize: 5, order: 1 },
  material: APP_STEEL,
  supports: [
    { name: "Pin", faces: [pinPad], dofs: [0, 1, 2], value: 0 },
    { name: "Roller", faces: [rollerPad], dofs: [1], value: 0 },
  ],
  loads: [
    {
      name: "Central load",
      kind: "force",
      faces: [loadPad],
      components: [0, -F, 0],
    },
  ],
  optimize: {
    objective: "min_compliance",
    volumeFraction: 0.5,
    penalty: 3,
    // Two element sizes. At 1.5 element sizes (the 88-line code's ratio) the
    // tetrahedral design keeps flipping elements at the move limit and never
    // meets the tolerance; at two it converges to the same truss.
    filterRadius: 10,
    moveLimit: 0.2,
    maxIterations: 100,
    tolerance: 0.01,
  },
  readout: {
    quantity: "Final compliance",
    probe: { kind: "compliance", unit: "N·mm" },
  },
};

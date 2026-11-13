// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Patch test across a tie between non-matching meshes.
//
//   A block in uniaxial tension, made of two bodies 1 mm apart — 40 mm and
//   60 mm long, meshed on their own by Netgen, so the nodes of the two facing
//   surfaces do not match — joined by a constraint (MPC) tie. Symmetry
//   supports on x = 0, y = 0 and z = 0 leave the block free to contract, so the
//   exact solution is the homogeneous state
//
//     σxx = σ, all other stresses 0,
//
// in both bodies; the tie bridges the gap rigidly, which shifts the far body
// by the gap without straining it. Linear elements represent this state
// exactly, and so does a correctly formulated tie: a mesh-tying method passes
// the patch test when the uniform stress is reproduced to round-off, across
// the interface as everywhere else. Node-to-surface projection fails it,
// with stress jumps at the tie that do not go away under refinement; the dual
// mortar weights of the Rust solver (crates/kofem-fem/src/mortar.rs) pass.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the two
// blocks as one STEP file, mesh them (10 mm, linear tetrahedra), set the
// symmetry supports and the end load, add a tie between the two facing
// faces, solve, and read the largest von Mises stress.
//
// Reference: the patch test of B. M. Irons; for mesh tying, M. A. Puso, "A 3D
// mortar method for solid mechanics", IJNME 59 (2004) 315–336.

import { extrudedProfilesStep, line } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const LA = 40, // mm, body 1 along x
  LB = 60, // mm, body 2 along x
  GAP = 1, // mm between them
  W = 40, // mm along y
  H = 40; // mm along z (the extrusion)
const sigma = 100; // MPa
const XB = LA + GAP; // where body 2 starts
const END = XB + LB; // the loaded end

const block = (x0, x1) => ({
  outer: [line([x1, 0]), line([x1, W]), line([x0, W]), line([x0, 0])],
  holes: [],
});

// A point in the middle of each face a user clicks.
const midA = LA / 2,
  midB = XB + LB / 2;
const face = {
  symmetryX: { at: [0, W / 2, H / 2] },
  symmetryY: [{ at: [midA, 0, H / 2] }, { at: [midB, 0, H / 2] }],
  symmetryZ: [{ at: [midA, W / 2, 0] }, { at: [midB, W / 2, 0] }],
  loaded: { at: [END, W / 2, H / 2] },
  tieA: { at: [LA, W / 2, H / 2] },
  tieB: { at: [XB, W / 2, H / 2] },
};

export default {
  id: "tie-patch-test",
  name: "Tie patch test",
  quantity: "largest von Mises stress",
  unit: "MPa",
  tolPct: 0.01,
  // The displacement, not the stress: the stress is uniform to round-off, so a
  // colour scale stretched over its range would paint noise.
  readout: { field: "Ux", stat: "Max" },
  page: {
    summary:
      "Uniform tension across a tie between non-matching meshes. The exact answer is reproduced to round-off.",
    model: `Block in two bodies, ${LA} mm and ${LB} mm long, W × H section, ${GAP} mm apart, meshed on their own and tied.`,
    inputs: [
      ["L₁, L₂", `${LA}, ${LB}`, "mm"],
      ["gap", GAP, "mm"],
      ["W × H", `${W} × ${H}`, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["σ", sigma, "MPa"],
    ],
    supports:
      "Symmetry: Ux = 0 on x = 0, Uy = 0 on both y = 0 faces, Uz = 0 on both z = 0 faces.",
    loads: "σ·W·H in +x as a force on the far end face.",
    ties: "The two facing faces, by constraint (MPC), whole surface.",
    measured: "Largest von Mises stress over the model (nodal average).",
    source: "patch test (Irons); Puso (2004)",
  },
  recipe: {
    step: () =>
      extrudedProfilesStep([block(0, LA), block(XB, END)], H, "Tied block"),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 10, order: 1 },
    material: APP_STEEL,
    supports: [
      {
        name: "Symmetry x",
        faces: [face.symmetryX],
        dofs: [0],
        value: 0,
      },
      { name: "Symmetry y", faces: face.symmetryY, dofs: [1], value: 0 },
      { name: "Symmetry z", faces: face.symmetryZ, dofs: [2], value: 0 },
    ],
    loads: [
      {
        name: "Tension",
        kind: "force",
        faces: [face.loaded],
        components: [sigma * W * H, 0, 0],
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
      quantity: "Largest von Mises stress",
      probe: { kind: "stress", field: "vonMises", stat: "max", unit: "MPa" },
      formula: "σ (uniform)",
      reference: sigma,
    },
  },
};

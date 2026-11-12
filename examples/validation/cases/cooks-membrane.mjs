// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cook's membrane — the standard combined bending + shear distortion benchmark.
//
//   Tapered panel (0,0)-(48,44)-(48,60)-(0,44), clamped on x=0, a uniformly
//   distributed vertical shear F on the right edge x=48. E = 1, ν = 1/3, unit
//   thickness, F = 1. The benchmark is dimensionless; in the app's units it is
//   E = 1 MPa, F = 1 N and lengths in mm, so the deflection reads in mm.
//
// Reference: the converged plane-stress deflection 23.96 (Belytschko et al.
// 2014, Table 8.1; Cook 1989 rounds it to 23.91). That value, and the tables of
// standard elements it is compared with (bilinear quads: 11.80, 18.29, 22.08,
// 23.43 on 2 × 2 … 16 × 16 meshes), belong to the middle of the loaded edge,
// M = (48, 52): an independent plane-stress Q4 solve reproduces the 4 × 4,
// 8 × 8 and 16 × 16 entries at M to four digits (18.30, 22.08, 23.43; 11.85 on
// 2 × 2), and converged Q9 elements (128 × 128) give 23.97 there. Many write-ups put the point at the top corner C = (48, 60),
// where the converged plane-stress value is about 25.2 instead; this case used
// to compare C with 23.9, which is why it never converged to its reference.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the slab as a
// STEP file, split the x = 48 face at y = 52 (so M is a CAD vertex, hence a
// mesh node, and the load face is two faces of equal area), mesh with Netgen
// (quadratic tetrahedra, 2 mm), clamp the x = 0 face, load both halves of the
// x = 48 face with one total force, solve, and read Uy at M on the z = 0 face.
//
// Quadratic tetrahedra: linear ones lock in the panel's bending and are still
// 0.5 % low at 1 mm (see the convergence study). The 3-D slab clamped over its
// whole x = 0 face is slightly stiffer than the plane-stress panel (the clamp
// also stops the through-thickness contraction): the slab converges to 23.94,
// 0.1 % below the plane-stress value. The tolerance of 1 % covers that gap and
// the spread of the published reference (23.91 – 23.96); the CI mesh is within
// 0.1 % of the converged slab.

import { prismStep } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = 1; // MPa (dimensionless benchmark)
const nu = 1 / 3;
const t = 1; // mm, slab thickness along z (the extrusion)
const F = 1; // N, total shear on the x = 48 edge
const yM = 52; // the middle of the loaded edge, 44 … 60

// Points well inside each face: what a user clicks to pick it.
const clamped = { at: [0, 22, t / 2] };
const loadedLower = { at: [48, 48, t / 2] };
const loadedUpper = { at: [48, 56, t / 2] };

export default {
  id: "cooks-membrane",
  name: "Cook's membrane",
  quantity: "loaded-edge deflection",
  unit: "mm",
  tolPct: 1,
  readout: { field: "Uy", stat: "Max" },
  figure: { view: [-0.15, -0.1, -1] },
  page: {
    summary:
      "Tapered, skewed cantilever in shear. A standard distortion benchmark.",
    model: "Trapezoid (0, 0)–(48, 44)–(48, 60)–(0, 44), extruded by t.",
    inputs: [
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["F", F, "N"],
    ],
    supports: "x = 0 face fixed (Ux, Uy, Uz).",
    loads:
      "F in +y as one force on the x = 48 face, split at y = 52 into two halves.",
    measured: "y-displacement at M (48, 52, 0), the middle of the loaded edge.",
    source: "Cook (1974); Belytschko et al. (2014), Table 8.1",
  },
  recipe: {
    step: () =>
      prismStep(
        [
          [0, 0],
          [48, 44],
          [48, 60],
          [0, 44],
        ],
        t,
        "Cook's membrane",
      ),
    splits: [
      {
        mode: "faces",
        faces: [{ at: [48, 50, t / 2] }],
        origin: [0, yM, 0],
        normal: [0, 1, 0],
      },
    ],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 2, order: 2 },
    // E and ν as the benchmark sets them; the density is the material form's
    // default (it does not enter a static solve).
    material: {
      name: "Membrane",
      young: E,
      poisson: nu,
      density: APP_STEEL.density,
    },
    supports: [{ name: "Clamp", faces: [clamped], dofs: [0, 1, 2], value: 0 }],
    loads: [
      {
        name: "Shear",
        kind: "force",
        faces: [loadedLower, loadedUpper],
        components: [0, F, 0],
      },
    ],
    readout: {
      quantity: "Deflection at M",
      // M on the z = 0 face: a CAD vertex after the split, so always a mesh
      // node (the mid-thickness point need not be one, and two nodes can lie
      // equally near it). The slab is symmetric about z = t/2, so Uy at
      // z = 0 and z = t agree to the discretisation error.
      probe: {
        kind: "displacement",
        component: 1,
        at: [48, yM, 0],
        unit: "mm",
      },
      formula: "converged plane-stress value",
      reference: 23.96,
    },
  },
};

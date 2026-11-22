// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// NAFEMS LE2 — cylindrical shell bending patch test (The Standard NAFEMS
// Benchmarks, TNSB Rev. 3, 1990).
//
//   A 30° sector of a cylindrical shell, mid-surface radius 1000 mm, 500 mm
//   long and 10 mm thick. Steel, E = 210 GPa, ν = 0.3. The straight edge AB
//   (θ = 0) is clamped, the curved edges AD and BC (z = 0, z = 500 mm) are
//   held axially, and the straight edge DC (θ = 30°) carries a uniform edge
//   moment of 1000 N·m per metre. The panel bends uniformly, so the
//   tangential stress on the outer surface is 6·m/t² = 60 MPa everywhere;
//   NAFEMS reads it at an interior point E.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the panel as a
// 10 mm thick solid STEP file, mark it Shell (the app collapses the curved
// wall to its mid-surface), clamp the edge θ = 0, hold the two ends axially,
// put the moment on the edge θ = 30°, solve, and read the hoop stress on the
// outer surface with a probe at E.
//
// Why this model:
//   - A patch test: the exact stress is uniform, so a shell model must
//     reproduce it on any mesh. Netgen's triangles are irregular, as NAFEMS'
//     distorted mesh is meant to be.
//   - The edge moment is a moment about the z axis on the edge θ = 30°: the
//     edge lies on that axis, so the app applies it as nodal moments on the
//     shell's rotations, shared along the edge by length.
//   - The outer surface is the shell's top (+normal) surface: the app keeps
//     the outer face of a curved wall and points the facet normals out of it.
//
// Read-out: the largest principal stress on the outer surface at E,
// z = 300 mm, θ = 20°. The hoop direction there is no global axis, but the
// state is the patch test's: σθθ = 6·m/t², σzz = ν·σθθ (the ends are held
// axially) and no shear, so the largest principal stress is σθθ.
//
// Tolerance: 3 %.

import { cylindricalPanelStep } from "../../gallery/step-revolve.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const R = 1000; // mid-surface radius (mm)
const t = 10; // thickness (mm)
const L = 500; // length (mm)
const sweep = 30; // degrees
const m = 1000; // edge moment (N·mm per mm = N·m per m)
const h = 25; // Netgen maximum element size (mm)

const deg = Math.PI / 180;
// A point on the outer cylinder at angle θ (degrees) and height z.
const outer = (theta, z) => [
  (R + t / 2) * Math.cos(theta * deg),
  (R + t / 2) * Math.sin(theta * deg),
  z,
];
// A point in the middle of an end face (z = 0 or z = L) at angle θ.
const onEnd = (theta, z) => [
  R * Math.cos(theta * deg),
  R * Math.sin(theta * deg),
  z,
];
// A point in the middle of an edge face θ = const.
const onEdge = (theta) => onEnd(theta, L / 2);

export default {
  id: "nafems-le2",
  name: "NAFEMS LE2: cylindrical shell patch",
  quantity: "tangential stress at E, outer surface",
  unit: "MPa",
  tolPct: 3,
  figure: { field: "vonMises", view: [-1, -0.3, -0.6], deform: true },
  page: {
    summary:
      "The NAFEMS cylindrical shell patch under an edge moment: a uniform 60 MPa bending stress, from curved shells.",
    model: "The 30° panel as a curved shell of linear triangles.",
    inputs: [
      ["R", R, "mm"],
      ["t", t, "mm"],
      ["L", L, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["m", m, "N·mm/mm"],
    ],
    supports: "Edge θ = 0 clamped; the end edges z = 0 and z = L held in z.",
    loads: "Edge moment m·L about z on the edge θ = 30°.",
    measured:
      "Largest principal stress on the outer (top) surface at E, read with a probe: the hoop stress.",
    source: "NAFEMS TNSB Rev. 3 (1990), test LE2",
  },
  recipe: {
    step: () =>
      cylindricalPanelStep(R, t, L, sweep, "NAFEMS LE2 cylindrical panel"),
    splits: [],
    discretization: { kind: "shell", thickness: t },
    mesh: { maxElementSize: h, order: 1 },
    material: APP_STEEL,
    supports: [
      {
        name: "Clamped edge AB",
        faces: [{ at: onEdge(0) }],
        dofs: [0, 1, 2, 3, 4, 5],
        value: 0,
      },
      {
        name: "Axial ends",
        faces: [{ at: onEnd(sweep / 2, 0) }, { at: onEnd(sweep / 2, L) }],
        dofs: [2],
        value: 0,
      },
    ],
    loads: [
      {
        name: "Edge moment",
        kind: "moment",
        faces: [{ at: onEdge(sweep) }],
        axis: 2,
        value: m * L,
      },
    ],
    readout: {
      quantity: "Hoop stress at E",
      probe: {
        kind: "stress",
        field: "Max principal stress σ1",
        surface: "top",
        at: outer(20, 300),
        unit: "MPa",
      },
      formula: "NAFEMS LE2 target, 6·m / t²",
      reference: 60,
    },
  },
};

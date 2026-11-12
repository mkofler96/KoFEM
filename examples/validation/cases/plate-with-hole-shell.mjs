// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Plate with a hole as a shell — Kirsch's stress concentration on a shell
// mid-surface.
//
//   A square plate of half-width b = 10·a with a central hole of radius a,
//   pulled by a remote tension σ: a/b = 0.1, so the hole edge transverse to
//   the load reaches σ_max = Kt·σ with Kirsch's infinite-plate Kt = 3. The
//   5 mm wall is thin enough for the app to idealise the plate as a shell (it
//   treats walls up to 15 mm thick as thin). Loaded in its own plane, a flat
//   shell is in plane stress, the state Kirsch's solution describes. (The
//   solid plate-with-hole case is a different model: an eighth of a narrower
//   strip, 2a/W = 0.2, against Howland's Kt = 3.14 for that width.)
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the quarter
// plate as a STEP file, mark the body Shell, mesh it (the app measures the
// 5 mm wall and collapses it to a mid-surface of linear triangles), put
// symmetry supports on the edges x = 0 and y = 0, pull the edge x = b, solve,
// and read the largest nodal von Mises stress ÷ σ in the Results panel's hand
// check. The side faces of the plate collapse to the shell's edges, so each
// support and the load is an Edge pick of one whole CAD face.
//
// Reference: Kirsch (1898); Timoshenko & Goodier, "Theory of Elasticity",
// stress around a circular hole in a plate.

import { quarterPlateWithHoleStep } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const a = 10, // hole radius (mm)
  b = 100, // plate half-width (mm) — a/b = 0.1 ⇒ ≈ infinite-plate Kt
  t = 5; // wall thickness (mm)
const sigma = 100; // remote tension (MPa)
const h = 1; // Netgen maximum element size (mm)

// A point in the middle of each side face, at mid-thickness: on the shell it
// lies on the edge the face collapses to.
const symmetryX = { at: [0, (a + b) / 2, t / 2] }; // face x = 0
const symmetryY = { at: [(a + b) / 2, 0, t / 2] }; // face y = 0
const pulledEdge = { at: [b, b / 2, t / 2] }; // face x = b

export default {
  id: "plate-with-hole-shell",
  name: "Plate with a hole (shells)",
  quantity: "stress-concentration factor Kt",
  unit: "",
  // The read-out is the largest NODAL von Mises stress, the facets' constant
  // stresses averaged to the nodes, which reads a steep peak low and converges
  // slowly from below (convergence.mjs: Kt 2.20, 2.51, 2.82, 2.89 at 4, 2, 1,
  // 0.75 mm). The mesh is limited by the tetrahedra the shell is idealised
  // from: the mesh panel sets one global size, so 1 mm is the finest that runs
  // in CI and the GUI test in about a minute. 8 % covers the ~6 % left at
  // 1 mm; it is not slack around a lucky mesh.
  tolPct: 8,
  // The stress near the hole, seen face-on, undeformed.
  figure: {
    field: "vonMises",
    view: [0, 0, -1],
    deform: false,
    focus: { center: [16, 16, t / 2], half: 22, aspect: 1 },
  },
  page: {
    summary:
      "The plate with a hole as a shell mid-surface: Kirsch's Kt = 3 from shell triangles.",
    model:
      "Quarter of a square plate of half-width b and wall thickness t with a central hole of radius a, meshed as a shell.",
    inputs: [
      ["a", a, "mm"],
      ["b", b, "mm"],
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["σ", sigma, "MPa"],
    ],
    supports:
      "Symmetry on the edges x = 0 (Ux, Ry, Rz) and y = 0 (Uy, Rx, Rz); Uz fixed on both.",
    loads: "σ·b·t in +x as a force on the edge x = b.",
    measured: "Largest nodal von Mises stress, divided by σ.",
    source: "Kirsch (1898); Timoshenko & Goodier",
  },
  recipe: {
    step: () => quarterPlateWithHoleStep(a, b, t, "Quarter plate with a hole"),
    splits: [],
    discretization: { kind: "shell", thickness: t },
    mesh: { maxElementSize: h, order: 1 },
    material: APP_STEEL,
    supports: [
      {
        name: "Symmetry x = 0",
        faces: [symmetryX],
        dofs: [0, 2, 4, 5],
        value: 0,
      },
      {
        name: "Symmetry y = 0",
        faces: [symmetryY],
        dofs: [1, 2, 3, 5],
        value: 0,
      },
    ],
    loads: [
      {
        name: "Tension",
        kind: "force",
        faces: [pulledEdge],
        components: [sigma * b * t, 0, 0],
      },
    ],
    readout: {
      quantity: "Stress-concentration factor",
      probe: {
        kind: "stress",
        field: "vonMises",
        stat: "max",
        divideBy: sigma,
        unit: "",
      },
      formula: "Kt = 3 (infinite plate)",
      reference: 3,
    },
  },
};

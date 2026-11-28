// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Plate with a hole as a shell — the solid plate-with-hole case's strip, on a
// shell mid-surface.
//
//   The same long strip as plate-with-hole.mjs: width W = 2b, a central hole
//   of radius a (2a/W = 0.2), half-length L = 3b, thickness t, pulled by a
//   uniform tension σ at its ends. The hole edge across the load peaks at
//   σ_max = Kt·σ with Howland's Kt = 3.14 on the gross stress. Loaded in its
//   own plane, a flat shell is in plane stress, the state Howland's solution
//   describes, so the two pages compare one plate, solid against shell.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the quarter
// x, y ≥ 0 of the strip as a STEP file, mark the body Shell, give the hole
// face an element size, mesh it (the app pairs the plate's two faces, 1 mm
// apart, and meshes their mid-surface with linear triangles, KOF-498), put
// symmetry supports on the edges x = 0 and y = 0, pull the edge x = L, solve,
// and read the largest nodal von Mises stress ÷ σ in the Results panel's hand
// check. The side faces of the plate collapse to the shell's edges, so each
// support and the load is an Edge pick of one whole CAD face.
//
// Why this model:
//   - The full thickness: a shell is its mid-surface, so the solid case's
//     mid-plane symmetry has no counterpart here, and the load is σ·b·t, twice
//     the solid eighth's σ·b·t/2.
//   - Symmetry supports fix the displacement across each cut (Ux on x = 0, Uy
//     on y = 0) and the rotations a mirror plane forbids (Ry, Rz on x = 0;
//     Rx, Rz on y = 0). Uz is held on both cut edges too: the in-plane load
//     never moves the plate out of its plane, so this only stops it floating.
//   - The hole edge at h/8 = 0.125 mm (mesh.localSizes on the hole face,
//     KOF-394). The peak is a stress at a point, read as the average of the
//     one stress each triangle there reports at its centroid, so it is only
//     as good as the triangles at the hole. Refining the hole edge alone
//     takes the read-out from −8.9 % to −0.8 % for 7 % more elements;
//     refining the whole plate to 0.25 mm reaches only −1.7 % with 15 times
//     the elements (convergence.mjs).
//
// Tolerance: 8 %, as before the CAD mid-surface. Kt now converges from below
// as the mesh is refined with the hole edge at h/8: −2.2 % at 4 mm, −2.1 % at
// 2 mm, −0.8 % at 1 mm (the CI mesh), −0.03 % at 0.5 mm.
//
// References: Kirsch (1898); Howland, Phil. Trans. R. Soc. A 229 (1930) 49–86;
// Pilkey & Pilkey, Peterson's Stress Concentration Factors, chart 4.1.

import { quarterStripWithHoleStep } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const a = 10, // hole radius (mm)
  b = 50, // strip half-width (mm): W = 2b, 2a/W = 0.2
  L = 150, // strip half-length (mm), three half-widths
  t = 1; // wall thickness (mm), the whole of it: a shell has no mid-plane cut
const sigma = 100; // gross tension at the ends (MPa)
const h = 1; // Netgen maximum element size (mm)

// Howland's Kt on the gross stress for 2a/W = 0.2.
const KT_HOWLAND = 3.14;

// A point in the middle of each side face, at mid-thickness: on the shell it
// lies on the edge the face collapses to.
const symmetryX = { at: [0, (a + b) / 2, t / 2] }; // face x = 0, y ∈ [a, b]
const symmetryY = { at: [(a + L) / 2, 0, t / 2] }; // face y = 0, x ∈ [a, L]
const pulledEdge = { at: [L, b / 2, t / 2] }; // face x = L
const holeFace = { at: [a * Math.SQRT1_2, a * Math.SQRT1_2, t / 2] }; // r = a

export default {
  id: "plate-with-hole-shell",
  name: "Plate with a hole (shells)",
  quantity: "stress-concentration factor Kt",
  unit: "",
  tolPct: 8,
  // The stress around the hole, seen face-on, undeformed: the solid page's view.
  figure: {
    field: "vonMises",
    view: [0, 0, -1],
    deform: false,
    focus: {
      center: [2.2 * a, 1.32 * a, t / 2],
      half: 2.2 * a,
      aspect: 0.6,
    },
  },
  page: {
    summary:
      "The solid page's strip with a hole, as a shell mid-surface: Howland's Kt = 3.14 from linear shell triangles.",
    model:
      "Quarter of a long strip with a central hole, x, y ≥ 0, full thickness, meshed as a shell with the hole edge refined to 0.125 mm.",
    inputs: [
      ["a", a, "mm"],
      ["b", b, "mm"],
      ["L", L, "mm"],
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["σ", sigma, "MPa"],
    ],
    supports:
      "Symmetry on the edges x = 0 (Ux, Ry, Rz) and y = 0 (Uy, Rx, Rz); Uz fixed on both.",
    loads: "σ·b·t in +x as a force on the edge x = L.",
    measured: "Largest nodal von Mises stress, divided by σ.",
    source: "Kirsch (1898); Howland (1930); Peterson's",
  },
  recipe: {
    step: () =>
      quarterStripWithHoleStep(a, b, L, t, "Plate with a hole (quarter)"),
    splits: [],
    discretization: { kind: "shell", thickness: t },
    mesh: {
      maxElementSize: h,
      order: 1,
      localSizes: [{ faces: [holeFace], size: h / 8 }],
    },
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
      formula: "Howland's Kt for 2a/W = 0.2",
      reference: KT_HOWLAND,
    },
  },
};

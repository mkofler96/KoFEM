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
// x, y ≥ 0 of the strip as a STEP file, mark the body Shell, mesh it (the app
// measures the 1 mm wall, well inside its 15 mm thin-wall limit, and collapses
// it to a mid-surface of linear triangles), put symmetry supports on the edges
// x = 0 and y = 0, pull the edge x = L, solve, and read the largest nodal von
// Mises stress ÷ σ in the Results panel's hand check. The side faces of the
// plate collapse to the shell's edges, so each support and the load is an
// Edge pick of one whole CAD face.
//
// Why this model:
//   - The full thickness: a shell is its mid-surface, so the solid case's
//     mid-plane symmetry has no counterpart here, and the load is σ·b·t, twice
//     the solid eighth's σ·b·t/2.
//   - Symmetry supports fix the displacement across each cut (Ux on x = 0, Uy
//     on y = 0) and the rotations a mirror plane forbids (Ry, Rz on x = 0;
//     Rx, Rz on y = 0). Uz is held on both cut edges too: the in-plane load
//     never moves the plate out of its plane, so this only stops it floating.
//
// Tolerance: 8 %. The read-out is the largest NODAL von Mises stress: each
// triangle has one constant stress, and the app averages them to the nodes.
// At A, where the peak is, only one or two triangles meet, so the read-out is
// their stress, and it lands a few percent above or below 3.14 depending on
// how the mesher cuts that corner — not on the element size. Netgen puts at
// least two elements along every edge, so next to the 1 mm cut edge the
// triangle at A stays about 0.6 mm on every mesh from 6 mm down, while the
// rest of the hole follows the maximum size: refining does not refine the
// peak, and the value does not settle (convergence.mjs; a sweep from 8 to
// 0.5 mm read −5.6 % to +7.7 %, the worst at 6 and 2.5 mm; on the finest
// meshes the peak moves to the next node along the hole and reads low). The
// CI mesh, 1 mm, reads +1.2 %; 8 % covers every level swept, so a user who
// re-meshes at another size still sees the hand check agree. It is a band for
// the scatter of constant-stress triangles at a peak, not a mesh picked for
// luck. The solid case's quadratic tetrahedra keep 3 %.
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
      "Quarter of a long strip with a central hole, x, y ≥ 0, full thickness, meshed as a shell.",
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
      formula: "Howland's Kt for 2a/W = 0.2",
      reference: KT_HOWLAND,
    },
  },
};

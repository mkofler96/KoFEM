// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Plate with a central circular hole — the Kirsch stress-concentration problem.
//
//   A long thin strip of width W = 2b with a central hole of radius a, pulled
//   by a uniform tension σ at its ends. At the hole edge across the load the
//   stress peaks at σ_max = Kt·σ. In an infinite plate Kt = 3 (Kirsch); in a
//   strip with 2a/W = 0.2, as here, Kt = 3.14 on the gross stress σ (Howland
//   1930; Heywood's and Peterson's fits give 3.14 too).
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import one eighth of
// the strip — the quarter x, y ≥ 0, half the thickness — as a STEP file, mesh
// it with Netgen (quadratic tetrahedra, 2 mm), put symmetry supports on the
// three cut faces (Ux on x = 0, Uy on y = 0, Uz on the mid-plane z = 0), pull
// the x = L end, solve, and read the largest von Mises stress on the hole face
// in the Results panel's hand check, divided by σ.
//
// Why this model:
//   - The symmetry supports are exact for the full strip and remove every
//     rigid-body motion without restraining the plate anywhere else. A fixed
//     end would stop its Poisson contraction, which is not Kirsch's problem.
//   - The strip is three widths long (L = 3b), so the uniform end tension has
//     become Howland's strip field long before it reaches the hole: a square
//     plate of this width reads Kt ≈ 3.3, not 3.14.
//   - The plate is thin (t = a / 10), so it is in plane stress as Kirsch and
//     Howland assume. Netgen puts at least two elements along every edge, so
//     the 0.5 mm edge through the thickness at the peak keeps the elements
//     there at about 0.3 mm on every mesh: a local refinement the mesher makes
//     by itself, as the app has no per-face element size.
//   - Quadratic elements: on this mesh linear tetrahedra read 3.35 (+6.5 %),
//     and they only come down slowly (convergence.mjs).
//
// Tolerance: 3 %. The app's stress is one value per element, at its centre,
// averaged to the nodes, so the hole-edge value is a stress a fraction of an
// element inside the plate, where the stress has started to fall. Over the
// convergence study (4, 2 and 1 mm, P2) the read-out stays 0.4–1.6 % below
// 3.14; 3 % covers that with margin, not a mesh picked for luck.
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
  t = 1; // plate thickness (mm); the model is its upper half, z ∈ [0, t/2]
const depth = t / 2;
const sigma = 100; // gross tension at the ends (MPa)

// Howland's Kt on the gross stress for 2a/W = 0.2.
const KT_HOWLAND = 3.14;

// A point inside each face: what a user clicks to pick it.
const symX = { at: [0, (a + b) / 2, depth / 2] }; // x = 0 cut, y ∈ [a, b]
const symY = { at: [(a + L) / 2, 0, depth / 2] }; // y = 0 cut, x ∈ [a, L]
const midPlane = { at: [L / 2, b / 2, 0] }; // z = 0, the plate's mid-plane
const end = { at: [L, b / 2, depth / 2] }; // x = L, the loaded end
const hole = { at: [a * Math.SQRT1_2, a * Math.SQRT1_2, depth / 2] };

export default {
  id: "plate-with-hole",
  name: "Plate with a hole",
  quantity: "stress-concentration factor Kt",
  unit: "",
  tolPct: 3,
  readout: { field: "Ux", stat: "Max" },
  // The stress around the hole, seen face-on, undeformed.
  figure: {
    field: "vonMises",
    view: [0, 0, -1],
    deform: false,
    focus: {
      center: [2.2 * a, 1.32 * a, depth / 2],
      half: 2.2 * a,
      aspect: 0.6,
    },
  },
  page: {
    summary:
      "Kirsch's stress concentration at a hole, in a strip of finite width. A peak stress, read as the app shows it.",
    model:
      "One eighth of a long strip with a central hole: the quarter x, y ≥ 0, upper half of the thickness.",
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
      "Symmetry: Ux on the x = 0 face, Uy on the y = 0 face, Uz on the mid-plane z = 0.",
    loads: "σ·b·t/2 in +x as a force on the x = L face.",
    measured:
      "Largest von Mises stress on the hole face, averaged to the nodes as the app shows it, divided by σ.",
    source: "Kirsch (1898); Howland (1930); Peterson's",
  },
  recipe: {
    step: () =>
      quarterStripWithHoleStep(
        a,
        b,
        L,
        depth,
        "Plate with a hole (one eighth)",
      ),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: 2, order: 2 },
    material: APP_STEEL,
    supports: [
      { name: "Symmetry x = 0", faces: [symX], dofs: [0], value: 0 },
      { name: "Symmetry y = 0", faces: [symY], dofs: [1], value: 0 },
      { name: "Mid-plane", faces: [midPlane], dofs: [2], value: 0 },
    ],
    loads: [
      {
        name: "Tension",
        kind: "force",
        faces: [end],
        components: [sigma * b * depth, 0, 0],
      },
    ],
    readout: {
      quantity: "Stress concentration σmax/σ",
      probe: {
        kind: "stress",
        field: "vonMises",
        stat: "max",
        faces: [hole],
        divideBy: sigma,
        unit: "",
      },
      formula: "Howland's Kt for 2a/W = 0.2",
      reference: KT_HOWLAND,
    },
  },
};

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// NAFEMS LE6 — skew plate under normal pressure (The Standard NAFEMS
// Benchmarks, TNSB Rev. 3, 1990).
//
//   A rhombus with 1 m sides and a 30° skew, A (0, 0), B (1, 0),
//   C (1 + cos 30°, sin 30°), D (cos 30°, sin 30°) m, 10 mm thick. Steel,
//   E = 210 GPa, ν = 0.3. All four edges are simply supported (uz = 0) and a
//   uniform pressure of 0.7 kPa pushes the plate down (−z). NAFEMS' target is
//   the maximum principal stress on the lower surface at the centre E:
//   0.802 MPa.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the rhombus as
// a 10 mm thick plate STEP file, mark it Shell (the app collapses it to its
// mid-surface), hold the four edges, put the pressure on the top face, solve,
// and read the largest principal stress on the bottom surface with a probe at
// E. Each edge is an Edge pick of one whole side face of the plate.
//
// Why this model:
//   - The edges hold Ux, Uy and Uz; the rotations are free. NAFEMS holds only
//     uz on the edges and pins A (ux, uy) and B (uy) against rigid motion. A
//     flat plate under a normal load bends without stretching its mid-surface
//     (linear theory: membrane and bending uncouple), so the in-plane holds
//     carry no force and change nothing in the bending; holding them on whole
//     edges keeps every support on whole CAD faces instead of on point pads.
//   - The lower surface is the shell's bottom surface. A flat wall keeps one
//     of its two faces as the source of its mid-surface and winds its facets
//     along that face's outward normal, so "top" is the kept face's side. On
//     this mesh the kept face is the upper one (z = t): the facet normals
//     point +z and "bottom" is z = 0, the tension side of the sagging plate
//     (it reads +0.804 MPa, the top surface the mirror −0.804 MPa as σ3).
//     The two faces have the same area, and which one is kept changes with
//     the mesh: at 100 and 50 mm the lower face is kept. The recipe then
//     stops with an error, since the pressure is picked on the upper face,
//     which is no longer on the shell; it never reads the wrong surface.
//   - The pressure acts on the top face along its inward normal, −z.
//
// Read-out: the largest principal stress on the bottom surface at E, the
// centre (A + C)/2.
//
// Tolerance: 2 %. Mesh study (maximum element size → σ1 at E, error against
// 0.802 MPa, triangles): 150 mm → +0.7 % (150), 100 mm → −2.2 % (207),
// 50 mm → −0.6 % (548), 25 mm → +0.3 % (1935), 12.5 mm → +0.4 % (7517),
// 8 mm → +0.5 % (18131). At 100 and 50 mm the lower face is kept, so those
// two were run with the pressure picked on it and the read-out on "top", the
// same physical model. The value settles about 0.5 % above NAFEMS' target;
// 2 % covers every mesh from 50 mm down. The case runs at 25 mm.

import { prismStep } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const a = 1000; // side (mm)
const skew = 30; // degrees
const t = 10; // thickness (mm)
const p = 0.7e-3; // pressure (MPa): 0.7 kPa
const h = 25; // Netgen maximum element size (mm)

const c = a * Math.cos((skew * Math.PI) / 180);
const s = a * Math.sin((skew * Math.PI) / 180);
/** @type {[number, number][]} */
const rhombus = [
  [0, 0], // A
  [a, 0], // B
  [a + c, s], // C
  [c, s], // D
];
// The middle of the side face from corner i to corner i + 1, at mid-thickness:
// on the shell it lies on the edge the face collapses to.
/** @param {number} i */
const side = (i) => {
  const [x0, y0] = rhombus[i];
  const [x1, y1] = rhombus[(i + 1) % 4];
  return {
    at: /** @type {[number, number, number]} */ ([
      (x0 + x1) / 2,
      (y0 + y1) / 2,
      t / 2,
    ]),
  };
};
const centre = [(a + c) / 2, s / 2]; // E = (A + C) / 2

export default {
  id: "nafems-le6",
  name: "NAFEMS LE6: skew plate",
  quantity: "max principal stress at E, lower surface",
  unit: "MPa",
  tolPct: 2,
  figure: { field: "vonMises", view: [0.3, -0.6, -1], deform: true },
  page: {
    summary:
      "The NAFEMS 30° skew plate under pressure: the bending stress at its centre, from flat shells.",
    model: "The whole rhombus as a flat shell of linear triangles.",
    inputs: [
      ["a", a, "mm"],
      ["skew", skew, "°"],
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["p", p, "MPa"],
    ],
    supports:
      "All four edges simply supported: Ux, Uy, Uz held, rotations free.",
    loads: "Pressure p on the top face, downwards.",
    measured:
      "Largest principal stress on the lower (bottom) surface at the centre E, read with a probe.",
    source: "NAFEMS TNSB Rev. 3 (1990), test LE6",
  },
  recipe: {
    step: () => prismStep(rhombus, t, "NAFEMS LE6 skew plate"),
    splits: [],
    discretization: { kind: "shell", thickness: t },
    mesh: { maxElementSize: h, order: 1 },
    material: APP_STEEL,
    supports: [
      {
        name: "Simply supported edges",
        faces: [side(0), side(1), side(2), side(3)],
        dofs: [0, 1, 2],
        value: 0,
      },
    ],
    loads: [
      {
        name: "Pressure",
        kind: "pressure",
        faces: [{ at: [centre[0], centre[1], t] }],
        value: p,
      },
    ],
    readout: {
      quantity: "Max principal stress at E",
      probe: {
        kind: "stress",
        field: "Max principal stress σ1",
        surface: "bottom",
        at: [centre[0], centre[1], 0],
        unit: "MPa",
      },
      formula: "NAFEMS LE6 target",
      reference: 0.802,
    },
  },
};

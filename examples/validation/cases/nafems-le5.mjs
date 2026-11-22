// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// NAFEMS LE5 — Z-section cantilever (The Standard NAFEMS Benchmarks, TNSB
// Rev. 3, 1990).
//
//   A cantilever 10 m long with a Z cross-section: a web 2 m deep between the
//   flange mid-planes and two flanges 1 m wide from the web mid-plane, running
//   to opposite sides; every wall is 0.1 m thick. Steel, E = 210 GPa, ν = 0.3.
//   The root is clamped and the free end carries a torque of 1.2 MN·m about
//   the beam axis, applied as two edge shears of 0.6 MN, one along each
//   flange's end edge. The clamped root restrains warping, so the torque
//   raises axial stresses near it; NAFEMS' target is the axial stress on the
//   mid-surface at A, 2.5 m from the root on the free edge of the lower
//   flange: σxx = −108 MPa.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the Z-section
// as a prism STEP file, cut its end face into web and flanges with two
// splits, mesh it with quadratic tetrahedra, clamp the root face, put a force
// on each flange's end face, solve, and read the axial stress with a probe at
// A.
//
// Axes: prismStep extrudes along +z, so the app's z is the beam axis (NAFEMS'
// x) and the section lies in the xy plane: app (x, y, z) = NAFEMS (y − 1 m,
// z, x), a rotation, so the section is NAFEMS' and not its mirror image. The
// web is the plane y = 0, x ∈ [−1, 1] m; the flange x = +1 m runs to +y (the
// figure's upper flange), the flange x = −1 m to −y (its lower one). NAFEMS'
// σxx is the app's σzz.
//
// Why this model:
//   - A solid, not shells: the app's shell idealisation welds walls at
//     T-junctions but not yet at the L-corners of a Z-section, and its
//     thin-wall limit is 15 mm. With 100 mm walls a solid of quadratic
//     tetrahedra models the beam directly.
//   - The torque as NAFEMS applies it to shells: 0.6 MN along each flange end
//     edge, +y on the flange x = +1 m and −y on the flange x = −1 m, a couple
//     of 0.6 MN × 2 m = 1.2 MN·m about +z (NAFEMS' +x, the upper flange's
//     shear pointing up as in the figure). The end face is one CAD face, so
//     two splits at the inner faces of the flanges, x = ±0.95 m, cut it into a
//     face for each flange and one for the web: every load sits on whole CAD
//     faces.
//   - Clamped root: the root face held in x, y and z (NAFEMS: all
//     displacements zero along the edge x = 0).
//   - Point A: on the free edge of the lower flange, 2.5 m from the root,
//     app (−1 m, −1 m, 2.5 m), where the restrained warping puts the largest
//     axial stress. The section and the torque are point-symmetric, so the
//     upper flange's edge reads the same.
//
// Read-out: σzz at A, in the middle of the flange's end face y = −1 m, as a
// probe placed there by its coordinates reads it.
//
// Tolerance: 3 %. The read-out settles about 1.5 % beyond the target as the
// mesh is refined (+0.9 %, +1.2 %, +1.4 % on 200, 100 and 70 mm): NAFEMS'
// value is a thin-shell one, and these walls are a tenth of a flange wide.

import { prismStep } from "../../gallery/step-prism.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const L = 10000; // length (mm)
const d = 2000; // web depth between the flange mid-planes (mm)
const b = 1000; // flange width from the web mid-plane (mm)
const t = 100; // wall thickness (mm)
const T = 1.2e9; // torque (N·mm)
const S = T / d; // edge shear on each flange (N)
const h = 100; // Netgen maximum element size (mm)

const w = d / 2; // flange mid-plane offset from the web mid-plane
const ht = t / 2;
// The Z-section, counter-clockwise: web y ∈ [−t/2, t/2], flange x = +w to +y,
// flange x = −w to −y, flange tips on y = ±b.
/** @type {[number, number][]} */
const section = [
  [-w - ht, -b],
  [-w + ht, -b],
  [-w + ht, -ht],
  [w + ht, -ht],
  [w + ht, b],
  [w - ht, b],
  [w - ht, ht],
  [-w - ht, ht],
];

export default {
  id: "nafems-le5",
  name: "NAFEMS LE5: Z-section cantilever",
  quantity: "axial stress at A, mid-surface",
  unit: "MPa",
  tolPct: 3,
  figure: { field: "vonMises", view: [-1, -0.7, -0.5], deform: true },
  page: {
    summary:
      "The NAFEMS Z-section cantilever under torque: the warping stress the clamped root raises, from quadratic tetrahedra.",
    model:
      "The Z-section beam as a solid of quadratic tetrahedra; the beam axis is z.",
    inputs: [
      ["L", L, "mm"],
      ["d", d, "mm"],
      ["b", b, "mm"],
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["T", T, "N·mm"],
    ],
    supports: "Root face z = 0 clamped.",
    loads:
      "T as two shears T/d on the flange end faces at z = L, +y on the flange x = +d/2, −y on the flange x = −d/2.",
    measured:
      "Axial stress σzz (NAFEMS' σxx) at A on the flange's outer face, read with a probe.",
    source: "NAFEMS TNSB Rev. 3 (1990), test LE5",
  },
  recipe: {
    step: () => prismStep(section, L, "NAFEMS LE5 Z-section cantilever"),
    splits: [
      {
        mode: "faces",
        faces: [{ at: [0, 0, L] }],
        origin: [w - ht, 0, 0],
        normal: [1, 0, 0],
      },
      {
        mode: "faces",
        faces: [{ at: [0, 0, L] }],
        origin: [-w + ht, 0, 0],
        normal: [1, 0, 0],
      },
    ],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: h, order: 2 },
    material: APP_STEEL,
    supports: [
      {
        name: "Clamped root",
        faces: [{ at: [0, 0, 0] }],
        dofs: [0, 1, 2],
        value: 0,
      },
    ],
    loads: [
      {
        name: "Shear, flange x = +d/2",
        kind: "force",
        faces: [{ at: [w, b / 2, L] }],
        components: [0, S, 0],
      },
      {
        name: "Shear, flange x = −d/2",
        kind: "force",
        faces: [{ at: [-w, -b / 2, L] }],
        components: [0, -S, 0],
      },
    ],
    readout: {
      quantity: "Axial stress at A",
      probe: {
        kind: "stress",
        field: "Normal stress σzz",
        at: [-w, -b, L / 4],
        unit: "MPa",
      },
      formula: "NAFEMS LE5 target",
      reference: -108,
    },
  },
};

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// NAFEMS LE3 — hemisphere with point loads (The Standard NAFEMS Benchmarks,
// TNSB Rev. 3, 1990).
//
//   A hemispherical shell of mid-surface radius 10 m and thickness 40 mm,
//   with an 18° hole about the pole: it spans elevation 0° to 72°.
//   E = 68.25 GPa, ν = 0.3. NAFEMS models a quarter, A on the equator on +x,
//   C on the equator on +y and E on the hole edge: symmetry about the zx plane
//   along AE and about the yz plane along CE, E held, and radial point loads
//   of 2 kN, outward at A and inward at C. The shell bends almost without
//   stretching, and NAFEMS gives Ux = 185 mm at A (MacNeal and Harder's
//   pinched hemisphere, scaled).
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import the quarter as
// a 40 mm thick solid STEP file, split 50 mm pieces off the equator edge at A
// and at C and off the hole edge at E, mark the body Shell (the app collapses
// the curved wall to its mid-surface), put symmetry supports on the two
// meridian edges, hold E in z, load the two pieces, solve, and read Ux with a
// probe at A.
//
// Why this model:
//   - The point loads sit on 50 mm pieces of the equator edge, the point
//     support on a 50 mm piece of the hole edge: every load and support in
//     KoFEM sits on whole CAD faces. On a 250 mm mesh, pieces of 20, 50, 100
//     and 200 mm read 183.19, 183.18, 183.14 and 183.09 mm: the piece's size
//     does not matter.
//   - The symmetry planes hold Uy, Rx, Rz on θ = 0 and Ux, Ry, Rz on θ = 90°,
//     which leaves only a rigid shift in z; E held in z stops it. The loads
//     are horizontal, so that support carries no force.
//   - The wall is 40 mm thick, over the app's absolute 15 mm limit for thin
//     walls; for a body marked Shell the limit grows to a tenth of the body's
//     size, and t/R = 0.004 is thin.
//
// Read-out: Ux at A = (10 000, 0, 0) on the mid-surface, read with a probe.
//
// Tolerance: 2 %. The flat facets' membrane is Felippa's OPT triangle, whose
// drilling DOF is the in-plane rotation about the smooth surface's normal
// (KOF-453). Ux reads 183.6, 186.7, 187.0 and 187.0 mm on meshes of 500, 250,
// 125 and 62.5 mm (1 400 to 83 000 triangles): it converges to 1.1 % above
// the target. With a fictitious drilling spring instead it drifted from
// 185.4 down to 178.4 mm. NAFEMS' own linear-triangle results lie further
// off (Abaqus S3: −13 % on its fine mesh). The example meshes at 250 mm.

import { sphericalShellStep } from "../../gallery/step-revolve.mjs";
import { benchmarkMaterial } from "../lib/recipe.mjs";

const E = 68250; // MPa
const nu = 0.3;
const R = 10000; // mid-surface radius (mm)
const t = 40; // thickness (mm)
const top = 72; // elevation of the hole edge (degrees)
const F = 2000; // radial point load on the quarter (N)
const patch = 50; // length of the loaded and held rim pieces (mm)
const h = 250; // Netgen maximum element size (mm)

const deg = Math.PI / 180;
// A point on the mid-surface at angle θ and elevation φ (degrees).
const mid = (theta, phi) => [
  R * Math.cos(phi * deg) * Math.cos(theta * deg),
  R * Math.cos(phi * deg) * Math.sin(theta * deg),
  R * Math.sin(phi * deg),
];
// The mid-surface point of the equator rim at distance d along it from θ = 0.
const nearA = (d) => [Math.sqrt(R * R - d * d), d, 0];
const nearC = (d) => [d, Math.sqrt(R * R - d * d), 0];
// The mid-surface point of the hole rim at distance d along it from θ = 0.
const rHole = R * Math.cos(top * deg);
const nearE = (d) => [
  Math.sqrt(rHole * rHole - d * d),
  d,
  R * Math.sin(top * deg),
];

export default {
  id: "nafems-le3",
  name: "NAFEMS LE3: hemisphere with point loads",
  quantity: "radial displacement at A",
  unit: "mm",
  tolPct: 2,
  figure: { field: "displacement", view: [-1, -0.6, -0.5], deform: true },
  page: {
    summary:
      "The NAFEMS pinched hemisphere with an 18° hole: 185 mm radial displacement under 2 kN, from curved shells.",
    model: "A quarter of the hemisphere as a curved shell of linear triangles.",
    inputs: [
      ["R", R, "mm"],
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["F", F, "N"],
    ],
    supports:
      "Symmetry on the edges θ = 0 and θ = 90°; Uz on a 50 mm piece of the hole edge.",
    loads:
      "2 kN outward at A and 2 kN inward at C, each on a 50 mm piece of the equator edge.",
    measured: "Ux at A = (10, 0, 0) m, read with a probe.",
    source: "NAFEMS TNSB Rev. 3 (1990), test LE3",
  },
  recipe: {
    step: () => sphericalShellStep(R, t, 0, top, 90, "NAFEMS LE3 hemisphere"),
    splits: [
      {
        mode: "faces",
        faces: [{ at: mid(45, 0) }, { at: nearE(rHole * Math.SQRT1_2) }],
        origin: [0, patch, 0],
        normal: [0, 1, 0],
      },
      {
        mode: "faces",
        faces: [{ at: mid(45, 0) }],
        origin: [patch, 0, 0],
        normal: [1, 0, 0],
      },
    ],
    discretization: { kind: "shell", thickness: t },
    mesh: { maxElementSize: h, order: 1 },
    material: benchmarkMaterial("NAFEMS LE3", E, nu),
    supports: [
      {
        name: "Symmetry y = 0",
        faces: [{ at: mid(0, 36) }],
        dofs: [1, 3, 5],
        value: 0,
      },
      {
        name: "Symmetry x = 0",
        faces: [{ at: mid(90, 36) }],
        dofs: [0, 4, 5],
        value: 0,
      },
      {
        name: "Uz at E",
        faces: [{ at: nearE(patch / 2) }],
        dofs: [2],
        value: 0,
      },
    ],
    loads: [
      {
        name: "2 kN out at A",
        kind: "force",
        faces: [{ at: nearA(patch / 2) }],
        components: [F, 0, 0],
      },
      {
        name: "2 kN in at C",
        kind: "force",
        faces: [{ at: nearC(patch / 2) }],
        components: [0, -F, 0],
      },
    ],
    readout: {
      quantity: "Ux at A",
      probe: { kind: "displacement", component: 0, at: [R, 0, 0], unit: "mm" },
      formula: "NAFEMS LE3 target",
      reference: 185,
    },
  },
};

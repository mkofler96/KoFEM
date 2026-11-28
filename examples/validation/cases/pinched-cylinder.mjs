// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Pinched cylinder with end diaphragms (Belytschko, Stolarski, Liu, Carpenter
// and Ong 1985, the shell "obstacle course").
//
//   A cylinder of mid-surface radius 300, length 600 and thickness 3, each end
//   closed by a rigid diaphragm (held radially and tangentially, free axially
//   and in rotation), pinched by two opposite radial point loads P = 1 at
//   mid-length. E = 3·10⁶, ν = 0.3. The numbers are the benchmark's own in
//   consistent units; KoFEM reads them as mm, N and MPa. The cylinder bends
//   almost without stretching, so a shell element that locks in membrane
//   moves far too little. The converged displacement under the load is
//   1.8248·10⁻⁵ (Belytschko et al. 1985, from a series solution).
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import an octant,
// θ from 0 to 90° and z from the mid-length plane z = 0 to the diaphragm at
// z = 300, as a 3 thick solid STEP file; split a short piece off the edge
// z = 0 at θ = 90°, where the load sits; mark the body Shell (the app
// collapses the wall to its mid-surface); hold the three symmetry edges and
// the diaphragm; load the piece with P/4 inward; solve; read Uy with a probe
// under the load.
//
// Why this model:
//   - Belytschko et al. model the same octant. The symmetry planes y = 0,
//     x = 0 and z = 0 hold the displacement normal to them and the two
//     rotations about the axes in them, which the Supports card offers as
//     Ux…Rz. The diaphragm holds Ux and Uy on the edge z = 300 and leaves
//     Uz and every rotation free.
//   - The point load sits on a short piece of the edge z = 0 next to θ = 90°:
//     every load in KoFEM sits on whole CAD faces, and the octant carries a
//     quarter of P. The piece is shorter than the finest mesh's elements, so
//     the load reaches the one or two nodes next to the load point.
//
// Read-out: Uy at (0, 300, 0), the load point on the mid-surface.

import { cylindricalPanelStep } from "../../gallery/step-revolve.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = 3e6; // MPa
const nu = 0.3;
const R = 300; // mid-surface radius (mm)
const t = 3; // thickness (mm)
const L = 600; // length between the diaphragms (mm)
const P = 1; // each of the two pinching loads (N)
const patch = 1; // length of the loaded piece of the edge z = 0 (mm)
const h = 10; // Netgen maximum element size (mm)

const deg = Math.PI / 180;
// A point on the mid-surface of an end face (z = 0 or z = L/2) at angle θ.
const onEnd = (theta, z) => [
  R * Math.cos(theta * deg),
  R * Math.sin(theta * deg),
  z,
];
// The mid-surface point of the edge z = 0 at distance d along it from θ = 90°.
const nearLoad = (d) => [d, Math.sqrt(R * R - d * d), 0];

export default {
  id: "pinched-cylinder",
  name: "Pinched cylinder with end diaphragms",
  quantity: "displacement under the load",
  unit: "mm",
  tolPct: 2,
  figure: { field: "displacement", view: [-0.8, -0.6, 0.9], deform: true },
  page: {
    summary:
      "The shell obstacle course's pinched cylinder: a thin cylinder between rigid diaphragms bent by two point loads, from curved shells.",
    model: "An octant of the cylinder as a curved shell of linear triangles.",
    inputs: [
      ["R", R, "mm"],
      ["L", L, "mm"],
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["P", P, "N"],
    ],
    supports:
      "Symmetry on the edges θ = 0, θ = 90° and z = 0; the diaphragm edge z = L/2 held in x and y.",
    loads: "P/4 inward on a 1 mm piece of the edge z = 0 at θ = 90°.",
    measured: "Uy at the load point (0, R, 0), read with a probe.",
    source: "Belytschko et al. (1985), pinched cylinder with diaphragms",
  },
  recipe: {
    step: () =>
      cylindricalPanelStep(R, t, L / 2, 90, "Pinched cylinder octant"),
    splits: [
      {
        mode: "faces",
        faces: [{ at: onEnd(45, 0) }],
        origin: [patch, 0, 0],
        normal: [1, 0, 0],
      },
    ],
    discretization: { kind: "shell", thickness: t },
    mesh: { maxElementSize: h, order: 1 },
    // E and ν as the benchmark sets them; the density is the material form's
    // default (it does not enter a static solve).
    material: {
      name: "Pinched cylinder",
      young: E,
      poisson: nu,
      density: APP_STEEL.density,
    },
    supports: [
      {
        name: "Symmetry y = 0",
        faces: [{ at: onEnd(0, L / 4) }],
        dofs: [1, 3, 5],
        value: 0,
      },
      {
        name: "Symmetry x = 0",
        faces: [{ at: onEnd(90, L / 4) }],
        dofs: [0, 4, 5],
        value: 0,
      },
      {
        name: "Symmetry z = 0",
        faces: [{ at: onEnd(45, 0) }, { at: nearLoad(patch / 2) }],
        dofs: [2, 3, 4],
        value: 0,
      },
      {
        name: "Diaphragm",
        faces: [{ at: onEnd(45, L / 2) }],
        dofs: [0, 1],
        value: 0,
      },
    ],
    loads: [
      {
        name: "P/4 at the load point",
        kind: "force",
        faces: [{ at: nearLoad(patch / 2) }],
        components: [0, -P / 4, 0],
      },
    ],
    readout: {
      quantity: "Uy under the load",
      probe: { kind: "displacement", component: 1, at: [0, R, 0], unit: "mm" },
      formula: "Belytschko et al. (1985)",
      reference: -1.8248e-5,
    },
  },
};

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// NAFEMS LE7 — cylinder with a hemispherical cap under internal pressure (The
// Standard NAFEMS Benchmarks, TNSB Rev. 3, 1990).
//
//   A thin pressure vessel: a cylinder of mid-surface radius 1000 mm from the
//   bottom edge F (z = 0) to z = 1500 mm, closed by a tangent hemisphere up to
//   the pole A (z = 2500 mm); 25 mm thick throughout. Steel, E = 210 GPa,
//   ν = 0.3. A uniform internal pressure of 1 MPa; F is held axially, the pole
//   is a symmetry point. The cap stretches half as much as the cylinder, so
//   the wall bends where they meet, and NAFEMS gives the axial stress
//   σzz = 25.9 MPa on the outer surface at D = (r 1000, z 1403.4) mm,
//   96.6 mm below the junction (the membrane value alone is p·R/(2t) =
//   20 MPa).
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import a 90° sector
// of the vessel as a 25 mm thick solid STEP file, mark it Shell (the app
// collapses the cylinder and the cap to their mid-surfaces), put symmetry
// supports on the two meridian edges, hold the bottom edge in z, press the
// wall from inside, solve, and read σzz on the outer surface with a probe
// at D.
//
// Why this model:
//   - The axisymmetric model as a 90° sector: θ = 0 holds Uy, Rx, Rz, θ = 90°
//     holds Ux, Ry, Rz, and the pole, on both planes, cannot move sideways,
//     as NAFEMS' symmetry point. The bottom edge is held in z only, so the
//     cylinder is free to breathe there.
//   - The internal pressure is −1 MPa on the outer faces of the cylinder and
//     the cap, the faces the shell keeps: the app presses along the face's
//     inward normal, and the shell carries a pressure on either face.
//   - The outer surface is the shell's top (+normal) surface: the app keeps
//     the outer face of a curved wall and points the facet normals out of it.
//   - The wall is 25 mm thick, over the app's absolute 15 mm limit for thin
//     walls; for a body marked Shell the limit grows to a tenth of the body's
//     size (here 290 mm), and t/R = 0.025 is thin.
//
// Read-out: σzz on the outer (top) surface at D on θ = 0, the point
// (1012.5, 0, 1403.4). The meridian is vertical there, so σzz is the
// meridional stress.
//
// Tolerance: 3 %. The bending layer at the junction decays over √(R·t) ≈
// 160 mm, so the mesh must resolve it: σzz reads 25.99, 25.93, 26.03 and
// 25.95 MPa on meshes of 50, 35, 25 and 17.5 mm (3 600 to 30 000 triangles),
// within 0.5 % of the target on every mesh. The example meshes at 25 mm.

import { cappedCylinderStep } from "../../gallery/step-revolve.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const R = 1000; // mid-surface radius (mm)
const t = 25; // thickness (mm)
const L = 1500; // cylinder length, F to the junction (mm)
const p = 1; // internal pressure (MPa)
const zD = 1403.4; // height of D (mm)
const h = 25; // Netgen maximum element size (mm)

const deg = Math.PI / 180;
const ro = R + t / 2; // outer radius
// A point on the outer cylinder at angle θ (degrees) and height z.
const onCylinder = (theta, z) => [
  ro * Math.cos(theta * deg),
  ro * Math.sin(theta * deg),
  z,
];
// A point on the outer hemisphere at angle θ and elevation φ above the
// junction (degrees).
const onCap = (theta, phi) => [
  ro * Math.cos(phi * deg) * Math.cos(theta * deg),
  ro * Math.cos(phi * deg) * Math.sin(theta * deg),
  L + ro * Math.sin(phi * deg),
];
// A point on the mid-surface of the meridian at θ, height z (on the
// cylinder): the middle of an edge face.
const onEdge = (theta, z) => [
  R * Math.cos(theta * deg),
  R * Math.sin(theta * deg),
  z,
];

export default {
  id: "nafems-le7",
  name: "NAFEMS LE7: cylinder with hemispherical cap",
  quantity: "axial stress at D, outer surface",
  unit: "MPa",
  tolPct: 3,
  figure: { field: "vonMises", view: [-1, -0.6, -0.4], deform: true },
  page: {
    summary:
      "The NAFEMS pressure vessel, a cylinder closed by a hemisphere: σzz = 25.9 MPa on the outer surface near the junction, from curved shells.",
    model: "A 90° sector as a curved shell of linear triangles.",
    inputs: [
      ["R", R, "mm"],
      ["t", t, "mm"],
      ["L", L, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["p", p, "MPa"],
    ],
    supports:
      "Symmetry on the edges θ = 0 and θ = 90°; the bottom edge z = 0 held in z.",
    loads: "1 MPa internal pressure on the cylinder and the cap.",
    measured:
      "σzz on the outer (top) surface at D = (1000, 0, 1403.4) mm, read with a probe.",
    source: "NAFEMS TNSB Rev. 3 (1990), test LE7",
  },
  recipe: {
    step: () => cappedCylinderStep(R, t, L, 90, "NAFEMS LE7 capped cylinder"),
    splits: [],
    discretization: { kind: "shell", thickness: t },
    mesh: { maxElementSize: h, order: 1 },
    material: APP_STEEL,
    supports: [
      {
        name: "Bottom edge, axial",
        faces: [{ at: onEdge(45, 0) }],
        dofs: [2],
        value: 0,
      },
      {
        name: "Symmetry y = 0",
        faces: [{ at: onEdge(0, L / 2) }],
        dofs: [1, 3, 5],
        value: 0,
      },
      {
        name: "Symmetry x = 0",
        faces: [{ at: onEdge(90, L / 2) }],
        dofs: [0, 4, 5],
        value: 0,
      },
    ],
    loads: [
      {
        name: "Internal pressure",
        kind: "pressure",
        faces: [{ at: onCylinder(45, L / 2) }, { at: onCap(45, 45) }],
        value: -p,
      },
    ],
    readout: {
      quantity: "Axial stress at D",
      probe: {
        kind: "stress",
        field: "Normal stress σzz",
        surface: "top",
        at: onCylinder(0, zD),
        unit: "MPa",
      },
      formula: "NAFEMS LE7 target",
      reference: 25.9,
    },
  },
};

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// NAFEMS LE8 — axisymmetric shell under pressure (The Standard NAFEMS
// Benchmarks, TNSB Rev. 3, 1990).
//
//   A closed thin shell of revolution, 10 mm thick: a cylinder, a toroidal
//   knuckle and a dished-in spherical end. Steel, E = 210 GPa, ν = 0.3, under
//   an internal pressure of 1 MPa. The open end A (z = 0) is held axially;
//   the pole is held radially and in rotation by symmetry. NAFEMS' target is
//   the hoop stress on the outer surface at D, where the knuckle meets the
//   end: 94.5 MPa.
//
// Geometry (mid-surface, in the (r, z) half-plane, mm). The NAFEMS figure
// gives the cylinder radius 250, the height 500 of the pole E above A, the
// knuckle radius 62.5, the end's radius 250 and the angle ≈ 36° of the knuckle
// arc CD; the end is concave seen from outside (it sags from D down to E).
// Both arcs are tangent at D and the end's centre lies on the axis, so the
// knuckle centre K = (250 − 62.5, z_B) and the end's centre S = (0, 500 + 250)
// lie 250 + 62.5 = 312.5 apart, with K 187.5 off the axis: sin α = 187.5 /
// 312.5 = 0.6, α = 36.87° (the figure's 36°), and z_B = 750 − 312.5·0.8 = 500.
//   A = (250, 0), B = (250, 500), K = (187.5, 500), C = (187.5, 562.5),
//   D = K + 62.5·(−0.6, 0.8) = (150, 550), S = (0, 750), E = (0, 500).
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import a 90° sector
// of the 10 mm thick wall as a solid STEP file (the wall's closed profile
// revolved about z), mark it Shell (the app collapses the cylinder, torus and
// sphere walls to their mid-surface), hold the end A axially, put symmetry
// supports on the two cut faces θ = 0 and θ = 90°, put the pressure on the
// three walls, solve, and read σyy on the outer surface with a probe at D on
// the cut θ = 0.
//
// Why this model:
//   - Thin shell, as NAFEMS' axisymmetric shell elements: the stress at D is
//     the bending of the knuckle, which linear tetrahedra through a 10 mm
//     wall cannot carry.
//   - A 90° sector with symmetry supports in place of the axisymmetric model:
//     on the cut θ = 0 (the plane y = 0) Uy, Rx and Rz are held, on the cut
//     θ = 90° (x = 0) Ux, Ry and Rz. At the pole both apply, which holds u_r
//     and the meridian rotation, as NAFEMS' pole support.
//   - The shell keeps the outer faces of all three walls (the dished end
//     follows the knuckle onto its outer face, though that is the end's
//     smaller face), so they are what a user picks, and the outer surface is
//     the shell's top surface. The pressure is put on them as −1 MPa (the
//     app's pressure pushes into the face it is on): it acts on the
//     mid-surface, as in NAFEMS' shell model.
//
// Read-out: σyy on the outer (top) surface at D on the cut θ = 0, where the
// hoop direction is the global y axis.
//
// Tolerance: 10 %. The FE value does not reach the NAFEMS target, and thin
// shell theory does not either: an axisymmetric Kirchhoff shell solution of
// this geometry (conical frustum elements, converged to 0.1 MPa) gives
// 88.0 MPa at D, 6.9 % below 94.5; Abaqus' axisymmetric SAX2 shells give
// 90.4 MPa (−4.4 %). The same check of NAFEMS LE9 reproduces its target to
// 0.5 %. Mesh study (maximum element size → σyy at D): 10 mm → 82.8 MPa,
// 7.5 mm → 85.8, 6 mm → 85.4, 5 mm → 85.7 (25k facets), and beyond the
// study 4 mm → 86.2 and 3 mm → 86.5 (70k facets): rising towards the
// thin-shell value, 2.6 % below it at 7.5 mm and 1.7 % at 3 mm, and 9.3 %
// below the target at 7.5 mm. The knuckle's radius is only 6 t, so its facets
// turn some 7° each at 7.5 mm; with the drilling axis on the smooth surface's
// normal (KOF-453) they approach the curved shell from the stiff side. Coarser
// meshes measure the knuckle's thickness more than 5e-4 of t off, which the
// GUI cannot correct.

import { arc, line, revolvedSectorStep } from "../../gallery/step-revolve.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const E = APP_STEEL.young; // MPa
const nu = APP_STEEL.poisson;
const t = 10; // thickness (mm)
const Rc = 250; // cylinder radius (mm)
const Rk = 62.5; // knuckle radius (mm)
const Rs = 250; // end radius (mm)
const zE = 500; // pole height (mm)
const p = 1; // internal pressure (MPa)
const sweep = 90; // degrees
const h = 7.5; // Netgen maximum element size (mm)

const sinA = (Rc - Rk) / (Rs + Rk); // 0.6
const cosA = Math.sqrt(1 - sinA * sinA); // 0.8
/** @type {[number, number]} */
const S = [0, zE + Rs]; // centre of the end
/** @type {[number, number]} */
const K = [Rc - Rk, S[1] - (Rs + Rk) * cosA]; // knuckle centre, z = z_B
const zB = K[1];
// A point at distance ρ from the knuckle centre along its ray through D.
/** @param {number} rho @returns {[number, number]} */
const onKD = (rho) => [K[0] - rho * sinA, K[1] + rho * cosA];
/** @param {number} rho @returns {[number, number]} */
const onKB = (rho) => [K[0] + rho, K[1]];
const ho = t / 2;

// The wall's closed profile, counter-clockwise (material on the left): up the
// outer cylinder, over the outer knuckle, down the outer face of the end to
// the pole, along the axis through the wall, back out along the inner faces
// and down the bore, and across the end A.
const profile = [
  line([Rc + ho, zB]),
  arc(onKD(Rk + ho), K, true),
  arc([0, S[1] - (Rs - ho)], S, false),
  line([0, S[1] - (Rs + ho)]),
  arc(onKD(Rk - ho), S, true),
  arc(onKB(Rk - ho), K, false),
  line([Rc - ho, 0]),
  line([Rc + ho, 0]),
];

const deg = Math.PI / 180;
// The (r, z) point at angle θ (degrees) of the sector.
/** @param {[number, number]} rz @param {number} theta @returns {[number, number, number]} */
const at = ([r, z], theta) => [
  r * Math.cos(theta * deg),
  r * Math.sin(theta * deg),
  z,
];
// Points at distance ρ from the knuckle and end centres, to pick faces by.
/** @param {number} rho @param {number} phi  angle from the knuckle's +r ray (degrees) */
const onKnuckle = (rho, phi) =>
  /** @type {[number, number]} */ ([
    K[0] + rho * Math.cos(phi * deg),
    K[1] + rho * Math.sin(phi * deg),
  ]);
/** @param {number} rho @param {number} rD  radius along the end */
const onEnd = (rho, rD) =>
  /** @type {[number, number]} */ ([rD, S[1] - Math.sqrt(rho * rho - rD * rD)]);
const midWall = /** @type {[number, number]} */ ([Rc, zB / 2]);

export default {
  id: "nafems-le8",
  name: "NAFEMS LE8: axisymmetric shell under pressure",
  quantity: "hoop stress at D, outer surface",
  unit: "MPa",
  tolPct: 10,
  figure: { field: "vonMises", view: [-1, -0.6, -0.4], deform: true },
  page: {
    summary:
      "The NAFEMS pressurised shell of revolution with a knuckle and a dished end: the hoop stress at the knuckle, from curved shells.",
    model:
      "A 90° sector of the wall as a curved shell of linear triangles, on symmetry supports.",
    inputs: [
      ["R cylinder", Rc, "mm"],
      ["R knuckle", Rk, "mm"],
      ["R end", Rs, "mm"],
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["p", p, "MPa"],
    ],
    supports:
      "End A held axially; symmetry on the cuts θ = 0 and θ = 90°, which also holds the pole.",
    loads:
      "Internal pressure 1 MPa: −1 MPa on the outer faces of the three walls.",
    measured:
      "σyy on the outer (top) surface at D on the cut θ = 0, read with a probe: the hoop stress.",
    source: "NAFEMS TNSB Rev. 3 (1990), test LE8",
  },
  recipe: {
    step: () =>
      revolvedSectorStep([profile], sweep, "NAFEMS LE8 shell of revolution"),
    splits: [],
    discretization: { kind: "shell", thickness: t },
    mesh: { maxElementSize: h, order: 1 },
    material: APP_STEEL,
    supports: [
      {
        name: "Axial end A",
        faces: [{ at: at([Rc, 0], sweep / 2) }],
        dofs: [2],
        value: 0,
      },
      {
        name: "Symmetry θ = 0",
        faces: [{ at: at(midWall, 0) }],
        dofs: [1, 3, 5],
        value: 0,
      },
      {
        name: "Symmetry θ = 90°",
        faces: [{ at: at(midWall, sweep) }],
        dofs: [0, 4, 5],
        value: 0,
      },
    ],
    loads: [
      {
        name: "Internal pressure",
        kind: "pressure",
        faces: [
          { at: at([Rc + ho, zB / 2], sweep / 2) },
          { at: at(onKnuckle(Rk + ho, 60), sweep / 2) },
          { at: at(onEnd(Rs - ho, 80), sweep / 2) },
        ],
        value: -p,
      },
    ],
    readout: {
      quantity: "Hoop stress at D",
      probe: {
        kind: "stress",
        field: "Normal stress σyy",
        surface: "top",
        at: at(onKD(Rk + ho), 0),
        unit: "MPa",
      },
      formula: "NAFEMS LE8 target",
      reference: 94.5,
    },
  },
};

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// NAFEMS LE11 — solid cylinder/taper/sphere under a temperature field (The
// Standard NAFEMS Benchmarks, TNSB Rev. 3, 1990).
//
//   A solid of revolution about z, in metres: a spherical shell segment
//   between radii 1.0 and 1.4 from the plane z = 0 (A = (1.0, 0),
//   B = (1.4, 0)) up to E = (0.7071, 0.7071) on the inner sphere and
//   D = (1.2124, 0.7) on the outer one; above it a ring whose inner face is
//   the cylinder r = 0.7071 from E up to H at z = 1.79, and whose outer face
//   tapers in a straight line from D to G = (1.0, 1.39) and then runs up the
//   cylinder r = 1.0 to I at z = 1.79. Steel, E = 210 GPa, ν = 0.3, with a
//   thermal expansion coefficient of 2.3e-4 /°C. The temperature rises
//   linearly in r and z: ΔT = r + z (°C, r and z in metres). The planes
//   z = 0 and z = 1.79 are held in z. NAFEMS gives σzz = −105 MPa at A.
//
// Built as a user builds it in the GUI (lib/recipe.mjs): import a 90° sector
// of the solid as a STEP file (mm), mesh it with quadratic tetrahedra, give
// the material its expansion coefficient, hold the two cut faces by symmetry
// and the bottom and top faces in z, add the temperature change
// ΔT = (√(x² + y²) + z) / 1000 (x, y, z in mm), solve, and read σzz with a
// probe at A.
//
// Why this model:
//   - The 90° sector with symmetry on its cut faces (Uy on y = 0, Ux on
//     x = 0) is the solid of revolution: the temperature field and the
//     supports are axisymmetric.
//   - Quadratic tetrahedra: a linear temperature field gives a linear thermal
//     strain, which a linear tetrahedron's constant strain cannot follow.
//
// Read-out: σzz at A = (1000, 0, 0) mm, as a probe placed there by its
// coordinates reads it: each element's stress at its corner A with the
// thermal strain removed, averaged over the elements that meet there.
//
// Tolerance: 3 %. The read-out converges from below: −3.0 %, −1.2 % and −0.6 %
// on meshes of 100, 50 and 35 mm (the page's convergence study).

import { revolvedSectorStep, line, arc } from "../../gallery/step-revolve.mjs";
import { APP_STEEL } from "../lib/recipe.mjs";

const alpha = 2.3e-4; // thermal expansion coefficient (1/°C)
const sweep = 90; // sector angle (degrees)
const h = 50; // Netgen maximum element size (mm)

// The profile in the (r, z) half-plane, mm.
const s45 = 1000 * Math.SQRT1_2;
const A = [1000, 0];
const B = [1400, 0];
const D = [Math.sqrt(1400 ** 2 - 700 ** 2), 700];
const E = [s45, s45];
const G = [1000, 1390];
const I = [1000, 1790];
const H = [s45, 1790];

const material = { ...APP_STEEL, expansion: alpha };

// A point at radius r and height z on the plane θ (degrees), mm.
const at = (r, z, theta) => [
  r * Math.cos((theta * Math.PI) / 180),
  r * Math.sin((theta * Math.PI) / 180),
  z,
];

export default {
  id: "nafems-le11",
  name: "NAFEMS LE11: solid cylinder/taper/sphere, temperature loading",
  quantity: "direct stress σzz at A",
  unit: "MPa",
  tolPct: 3,
  figure: { field: "vonMises", view: [-1, -1.4, -0.5], deform: true },
  page: {
    summary:
      "The NAFEMS solid of revolution under a linear temperature field: σzz = −105 MPa at A, from quadratic tetrahedra and a temperature change.",
    model:
      "A 90° sector of the solid of revolution, quadratic tetrahedra, a temperature change over the model.",
    inputs: [
      ["E", APP_STEEL.young, "MPa"],
      ["ν", APP_STEEL.poisson, ""],
      ["α", alpha, "1/°C"],
    ],
    supports:
      "Uy on the cut face y = 0, Ux on the cut face x = 0, Uz on the bottom z = 0 and the top z = 1790 mm.",
    loads: "Temperature change ΔT = (√(x² + y²) + z) / 1000 °C, x, y, z in mm.",
    measured: "σzz at A = (1000, 0, 0) mm, read with a probe.",
    source: "NAFEMS TNSB Rev. 3 (1990), test LE11",
  },
  recipe: {
    step: () =>
      revolvedSectorStep(
        [
          [
            line(B),
            arc(D, [0, 0], true),
            line(G),
            line(I),
            line(H),
            line(E),
            arc(A, [0, 0], false),
          ],
        ],
        sweep,
        "NAFEMS LE11 cylinder taper sphere",
      ),
    splits: [],
    discretization: { kind: "solid" },
    mesh: { maxElementSize: h, order: 2 },
    material,
    supports: [
      {
        name: "Symmetry y = 0",
        faces: [{ at: at(1200, 300, 0) }],
        dofs: [1],
        value: 0,
      },
      {
        name: "Symmetry x = 0",
        faces: [{ at: at(1200, 300, sweep) }],
        dofs: [0],
        value: 0,
      },
      {
        name: "Bottom z = 0",
        faces: [{ at: at(1200, 0, sweep / 2) }],
        dofs: [2],
        value: 0,
      },
      {
        name: "Top z = 1790",
        faces: [{ at: at(850, 1790, sweep / 2) }],
        dofs: [2],
        value: 0,
      },
    ],
    loads: [],
    temperature: { formula: "(sqrt(x^2 + y^2) + z) / 1000" },
    readout: {
      quantity: "Direct stress at A",
      probe: {
        kind: "stress",
        field: "Normal stress σzz",
        at: [A[0], 0, A[1]],
        unit: "MPa",
      },
      formula: "NAFEMS LE11 target",
      reference: -105,
    },
  },
};

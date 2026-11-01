// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Square beam under torsion — Saint-Venant torsion of a non-circular section.
//
//   Beam of length L along x, square b × b section, clamped at x=0, torque T
//   about the beam axis on the free end face. Angle of twist θ = T·L / (G·K),
//   G = E/(2(1+ν)), K = β·b⁴ with Roark's square-section constant
//   β = 1/3 − 0.21·(1 − 1/12) ≈ 0.1408.
//
// The torque is a moment load on the end face, which the app turns into
// tangential nodal forces ∝ r about the face centroid. The clamp restrains
// warping, which stiffens the bar slightly, hence the band.
//
// Reference: Timoshenko & Goodier, "Theory of Elasticity"; Roark's Formulas.

import { boxHexMesh, nodesWhere } from "../lib/mesh.mjs";
import { STEEL } from "../lib/app-model.mjs";

const E = STEEL.young_modulus; // MPa
const nu = STEEL.poisson_ratio;
const G = E / (2 * (1 + nu));
const L = 1000; // mm
const b = 100; // square side (mm)
const T = 1.0e6; // N·mm about x
const DIV = [20, 6, 6]; // elements along x, y, z

const beta = 1 / 3 - 0.21 * (1 - 1 / 12); // square-section (b/a = 1) constant
const K = beta * b ** 4;

export default {
  id: "beam-torsion",
  name: "Square beam under torsion",
  quantity: "angle of twist θ",
  unit: "rad",
  reference: (T * L) / (G * K),
  referenceLabel: "θ = T·L / (G·K)",
  tolPct: 5,
  readout: { field: "|U|", stat: "Max" },
  page: {
    summary:
      "Torsion of a square section, which warps. The clamp holds the warping back.",
    model:
      "Beam of length L along x, square b × b section; K = β·b⁴, β = 1/3 − 0.21·(1 − 1/12).",
    inputs: [
      ["L", L, "mm"],
      ["b", b, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["T", T, "N·mm"],
    ],
    supports: "x = 0 face fixed (Ux, Uy, Uz).",
    loads: "Torque T about x as a moment on the x = L face.",
    measured: "Mean rotation of the x = L face about the axis.",
    mesh: `${DIV.join(" × ")} grid`,
    source: "Timoshenko & Goodier, Theory of Elasticity; Roark",
    grid: DIV,
  },
  model() {
    const m = boxHexMesh(L, b, b, ...DIV);
    return {
      title: this.name,
      mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
      material: STEEL,
      order: 1,
      support: {
        nodes: nodesWhere(m.vertices, (x) => x <= 1e-9),
        label: "Clamped end x = 0",
      },
      load: {
        kind: "moment",
        axis: 0,
        value: T,
        nodes: nodesWhere(m.vertices, (x) => x >= L - 1e-9),
        label: "Torque (about X)",
      },
      resultType: "Displacement (magnitude)",
    };
  },
  // θ = mean of (r × u)_x / r² over the end-face nodes off the axis.
  measure(model, result) {
    const { vertices } = model.mesh;
    const tip = model.load.nodes;
    const cy = tip.reduce((s, v) => s + vertices[v][1], 0) / tip.length;
    const cz = tip.reduce((s, v) => s + vertices[v][2], 0) / tip.length;
    let sum = 0,
      n = 0;
    for (const v of tip) {
      const y = vertices[v][1] - cy,
        z = vertices[v][2] - cz;
      const r2 = y * y + z * z;
      if (r2 < 1e-9) continue;
      sum +=
        (y * result.displacements[3 * v + 2] -
          z * result.displacements[3 * v + 1]) /
        r2;
      n++;
    }
    return sum / n;
  },
};

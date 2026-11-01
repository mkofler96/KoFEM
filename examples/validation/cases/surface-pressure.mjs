// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The axial bar compressed by a uniform pressure on its end face.
//
//   Pressure acts along the inward normal, so a positive p shortens the bar:
//   u(L) = −p·L/E, independent of the cross-section. Checks the sign of
//   pressure loads and that p is a force per area, not a total force.

import { boxHexMesh, nodesWhere } from "../lib/mesh.mjs";
import { STEEL } from "../lib/app-model.mjs";

const E = STEEL.young_modulus; // MPa
const nu = STEEL.poisson_ratio;
const L = 1000; // mm
const W = 100,
  H = 100; // cross-section (mm)
const p = 1.0; // pressure (MPa) on the x = L face
const DIV = [20, 4, 4]; // elements along x, y, z

export default {
  id: "surface-pressure",
  name: "Bar under end pressure",
  quantity: "tip displacement u",
  unit: "mm",
  reference: -(p * L) / E, // u(L) = −p·L/E (compression)
  referenceLabel: "u = −p·L / E",
  tolPct: 2,
  readout: { field: "Ux", stat: "Min" },
  page: {
    summary:
      "The bar pushed by a pressure. Checks the sign and the per-area scaling of pressure loads.",
    model: "Prismatic bar of length L along x, W × H section.",
    inputs: [
      ["L", L, "mm"],
      ["W × H", `${W} × ${H}`, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["p", p, "MPa"],
    ],
    supports: "x = 0 face fixed (Ux, Uy, Uz).",
    loads: "Pressure p on the x = L face.",
    measured: "Mean x-displacement of the x = L face.",
    mesh: `${DIV.join(" × ")} grid`,
    source: "Gere & Goodno, Mechanics of Materials",
    grid: DIV,
  },
  model() {
    const m = boxHexMesh(L, W, H, ...DIV);
    return {
      title: this.name,
      mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
      material: STEEL,
      order: 1,
      support: {
        nodes: nodesWhere(m.vertices, (x) => x <= 1e-9),
        label: "Fixed end x = 0",
      },
      load: {
        kind: "pressure",
        value: p,
        nodes: nodesWhere(m.vertices, (x) => x >= L - 1e-9),
        label: "End pressure",
      },
      resultType: "Ux",
    };
  },
  measure(model, result) {
    const nodes = model.load.nodes;
    return (
      nodes.reduce((s, v) => s + result.displacements[3 * v], 0) / nodes.length
    );
  },
};

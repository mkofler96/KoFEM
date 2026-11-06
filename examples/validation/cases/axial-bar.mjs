// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Axial bar in uniaxial tension — the simplest sanity benchmark.
//
//   A prismatic bar, fixed at x=0, pulled by a total axial force P over the x=L
//   face, applied as the app applies a force to a face: a uniform traction
//   integrated into work-equivalent nodal forces. Closed-form tip extension:
//   δ = P·L / (E·A).
//
// Reference: any mechanics-of-materials text (e.g. Gere & Goodno, "Mechanics of
// Materials", axially loaded members).

import { boxHexMesh, nodesWhere } from "../lib/mesh.mjs";
import { STEEL } from "../lib/app-model.mjs";

const E = STEEL.young_modulus; // MPa
const nu = STEEL.poisson_ratio;
const L = 1000; // mm
const W = 100,
  H = 100; // cross-section (mm)
const P = 1.0e6; // total axial force (N)
const DIV = [20, 4, 4]; // elements along x, y, z

const mean = (nodes, f) => nodes.reduce((s, v) => s + f(v), 0) / nodes.length;

// Shared by the public case and the Theory Guide's mesh/order comparison.
export function axialBarModel(title, divisions = DIV, order = 1) {
  const m = boxHexMesh(L, W, H, ...divisions);
  return {
    title,
    mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
    material: STEEL,
    order,
    support: {
      nodes: nodesWhere(m.vertices, (x) => x <= 1e-9),
      label: "Fixed end x = 0",
    },
    load: {
      kind: "force",
      axis: 0,
      value: P,
      nodes: nodesWhere(m.vertices, (x) => x >= L - 1e-9),
      label: "Axial load (+X)",
    },
    resultType: "Displacement (magnitude)",
  };
}

export default {
  id: "axial-bar",
  name: "Axial bar in tension",
  quantity: "tip extension δ",
  unit: "mm",
  reference: (P * L) / (E * (W * H)), // δ = PL/EA
  referenceLabel: "δ = P·L / (E·A)",
  tolPct: 2,
  readout: { field: "Ux", stat: "Max" },
  page: {
    summary:
      "Uniform tension. Checks material, supports and how a face load reaches the nodes.",
    model: "Prismatic bar of length L along x, W × H section.",
    inputs: [
      ["L", L, "mm"],
      ["W × H", `${W} × ${H}`, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["P", P, "N"],
    ],
    supports: "x = 0 face fixed (Ux, Uy, Uz).",
    loads: "P in +x as a force on the x = L face.",
    measured: "Mean x-displacement of the x = L face.",
    mesh: `${DIV.join(" × ")} grid`,
    source: "Gere & Goodno, Mechanics of Materials",
    grid: DIV,
  },
  model() {
    return axialBarModel(this.name);
  },
  measure(model, result) {
    return mean(model.load.nodes, (v) => result.displacements[3 * v]);
  },
};

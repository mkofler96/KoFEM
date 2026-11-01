// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cantilever beam with an end load — Euler–Bernoulli bending.
//
//   Beam of span L along x, b × h section, clamped at x=0, transverse load P
//   (−y) on the free end face x=L. Tip deflection  δ = −P·L³ / (3·E·I),
//   I = b·h³/12.
//
// Linear hexes are too stiff in bending (shear locking), so the mesh is fine
// along the span and the band allows a few percent.
//
// Reference: Euler–Bernoulli beam theory (Gere & Goodno, deflections of beams).

import { boxHexMesh, nodesWhere } from "../lib/mesh.mjs";
import { STEEL } from "../lib/app-model.mjs";

const E = STEEL.young_modulus; // MPa
const nu = STEEL.poisson_ratio;
const L = 1000; // mm
const b = 100,
  h = 100; // cross-section (mm)
const P = 1.0e4; // tip load (N), downward
const DIV = [40, 4, 4]; // elements along x, y, z

const I = (b * h ** 3) / 12;

export const cantileverInputs = [
  ["L", L, "mm"],
  ["b × h", `${b} × ${h}`, "mm"],
  ["E", E, "MPa"],
  ["ν", nu, ""],
  ["P", P, "N"],
];
export const cantileverReference = -(P * L ** 3) / (3 * E * I); // downward

/** The cantilever on an nx × ny × nz hex grid at element order `order`. */
export function cantileverModel(title, [nx, ny, nz], order) {
  const m = boxHexMesh(L, b, h, nx, ny, nz);
  return {
    title,
    mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
    material: STEEL,
    order,
    support: {
      nodes: nodesWhere(m.vertices, (x) => x <= 1e-9),
      label: "Clamped end x = 0",
    },
    load: {
      kind: "force",
      axis: 1,
      value: -P,
      nodes: nodesWhere(m.vertices, (x) => x >= L - 1e-9),
      label: "Tip load (−Y)",
    },
    resultType: "Uy",
  };
}

/** Mean y-deflection of the loaded end face. */
export function cantileverTip(model, result) {
  const nodes = model.load.nodes;
  return (
    nodes.reduce((s, v) => s + result.displacements[3 * v + 1], 0) /
    nodes.length
  );
}

export default {
  id: "cantilever",
  name: "Cantilever beam, linear hexahedra",
  quantity: "tip deflection δ",
  unit: "mm",
  reference: cantileverReference,
  referenceLabel: "δ = P·L³ / (3·E·I)",
  tolPct: 6,
  readout: { field: "Uy", stat: "Min" },
  page: {
    summary:
      "Bending with linear elements, which are too stiff in bending (shear locking).",
    model: "Beam of span L along x, b × h section, I = b·h³/12.",
    inputs: cantileverInputs,
    supports: "x = 0 face fixed (Ux, Uy, Uz).",
    loads: "P in −y as a force on the x = L face.",
    measured: "Mean y-displacement of the x = L face.",
    mesh: `${DIV.join(" × ")} grid`,
    source: "Euler–Bernoulli beam theory",
    grid: DIV,
  },
  model() {
    return cantileverModel(this.name, DIV, 1);
  },
  measure: cantileverTip,
};

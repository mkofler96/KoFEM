// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The quadratic cantilever of cantilever-bending-p2.mjs, cut at mid-span into
// two separately meshed bodies — 2 × 2 elements across on the clamped half,
// 3 × 3 on the loaded half — and joined by a constraint (MPC) tie.
//
// Unlike the patch test, bending is not a linear field: the tie has to carry a
// shear force and a bending moment across faces whose nodes do not match, with
// quadratic elements on both sides. Tied correctly, the beam deflects as the
// unsplit one does, δ = P·L³ / (3·E·I).
//
// Reference: Euler–Bernoulli beam theory (Gere & Goodno, deflections of beams).

import { boxHexMesh, joinParts, nodesWhere } from "../lib/mesh.mjs";
import { STEEL } from "../lib/app-model.mjs";
import {
  cantileverInputs,
  cantileverReference,
  cantileverTip,
} from "./cantilever-bending.mjs";

const L = 1000; // mm, as cantilever-bending.mjs
const b = 100,
  h = 100;
const P = 1.0e4; // N
const DIV_A = [5, 2, 2]; // clamped half, x ∈ [0, L/2]
const DIV_B = [5, 3, 3]; // loaded half, x ∈ [L/2, L]

const near = (u, v) => Math.abs(u - v) < 1e-9;

export function tiedCantileverModel(title) {
  const m = joinParts([
    { mesh: boxHexMesh(L / 2, b, h, ...DIV_A) },
    { mesh: boxHexMesh(L / 2, b, h, ...DIV_B), offset: [L / 2, 0, 0] },
  ]);
  const inA = (i) => i < m.firstVertex[1];
  return {
    title,
    mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
    bodies: m.bodies,
    material: STEEL,
    order: 2,
    support: {
      nodes: nodesWhere(m.vertices, (x) => near(x, 0)),
      label: "Clamped end x = 0",
    },
    load: {
      kind: "force",
      axis: 1,
      value: -P,
      nodes: nodesWhere(m.vertices, (x) => near(x, L)),
      label: "Tip load (−Y)",
    },
    ties: [
      {
        name: "Tie1",
        a: {
          nodes: nodesWhere(
            m.vertices,
            (x, y, z, i) => inA(i) && near(x, L / 2),
          ),
          label: "Clamped half, x = L/2",
        },
        b: {
          nodes: nodesWhere(
            m.vertices,
            (x, y, z, i) => !inA(i) && near(x, L / 2),
          ),
          label: "Loaded half, x = L/2",
        },
        extent: "full",
        searchDistance: 0,
        method: "mpc",
      },
    ],
    resultType: "Uy",
  };
}

export default {
  id: "tie-cantilever",
  name: "Tied cantilever, quadratic hexahedra",
  quantity: "tip deflection δ",
  unit: "mm",
  reference: cantileverReference,
  referenceLabel: "δ = P·L³ / (3·E·I)",
  tolPct: 4,
  readout: { field: "Uy", stat: "Min" },
  page: {
    summary:
      "A beam cut in two and tied across non-matching quadratic meshes deflects as the uncut beam.",
    model:
      "Beam of span L along x, b × h section, in two bodies tied at x = L/2.",
    inputs: cantileverInputs,
    supports: "x = 0 face fixed (Ux, Uy, Uz).",
    loads: "P in −y as a force on the x = L face.",
    measured: "Mean y-displacement of the x = L face vertices.",
    mesh: `${DIV_A.join(" × ")} and ${DIV_B.join(" × ")} grids, tied`,
    source: "Euler–Bernoulli beam theory",
    ties: true,
  },
  model() {
    return tiedCantileverModel(this.name);
  },
  measure: cantileverTip,
};

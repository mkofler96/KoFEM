// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Patch test across a tie between non-matching meshes.
//
//   A block in uniaxial tension, made of two separately meshed bodies that meet
//   on the plane x = L/2: 3 × 3 elements across on one side, 4 × 4 on the other,
//   so only the corner nodes of the interface coincide. A constraint (MPC) tie
//   joins them. Symmetry supports on x = 0, y = 0 and z = 0 leave the block
//   free to contract, so the exact solution is the homogeneous state
//
//     σxx = σ, all other stresses 0,   u = (σ/E)·(x, −ν·y, −ν·z),
//
// a linear displacement field. Linear elements represent it exactly, and so
// does a correctly formulated tie: a mesh-tying method passes the patch test
// when this state is reproduced to round-off, across the interface as
// everywhere else. Methods that fail it show stress jumps at the tie that do
// not go away under mesh refinement.
//
// Reference: the patch test of B. M. Irons; for mesh tying, M. A. Puso, "A 3D
// mortar method for solid mechanics", IJNME 59 (2004) 315–336.

import { boxHexMesh, joinParts, nodesWhere } from "../lib/mesh.mjs";
import { STEEL, solveModel } from "../lib/app-model.mjs";

const E = STEEL.young_modulus; // MPa
const nu = STEEL.poisson_ratio;
const L = 100; // mm, the whole block
const W = 40,
  H = 40; // cross-section (mm)
const sigma = 100; // MPa
const DIV_A = [4, 3, 3]; // x ∈ [0, L/2]
const DIV_B = [5, 4, 4]; // x ∈ [L/2, L]

const near = (a, b) => Math.abs(a - b) < 1e-9;

export function patchModel(title) {
  const m = joinParts([
    { mesh: boxHexMesh(L / 2, W, H, ...DIV_A) },
    { mesh: boxHexMesh(L / 2, W, H, ...DIV_B), offset: [L / 2, 0, 0] },
  ]);
  const inA = (i) => i < m.firstVertex[1];
  return {
    title,
    mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
    bodies: m.bodies,
    material: STEEL,
    order: 1,
    supports: [
      {
        nodes: nodesWhere(m.vertices, (x) => near(x, 0)),
        label: "Symmetry x = 0",
        dofs: [0],
      },
      {
        nodes: nodesWhere(m.vertices, (x, y) => near(y, 0)),
        label: "Symmetry y = 0",
        dofs: [1],
      },
      {
        nodes: nodesWhere(m.vertices, (x, y, z) => near(z, 0)),
        label: "Symmetry z = 0",
        dofs: [2],
      },
    ],
    load: {
      kind: "force",
      axis: 0,
      value: sigma * W * H,
      nodes: nodesWhere(m.vertices, (x) => near(x, L)),
      label: "Tension (+X)",
    },
    ties: [
      {
        name: "Tie1",
        a: {
          nodes: nodesWhere(
            m.vertices,
            (x, y, z, i) => inA(i) && near(x, L / 2),
          ),
          label: "Body 1, face x = L/2",
        },
        b: {
          nodes: nodesWhere(
            m.vertices,
            (x, y, z, i) => !inA(i) && near(x, L / 2),
          ),
          label: "Body 2, face x = L/2",
        },
        extent: "full",
        searchDistance: 0,
        method: "mpc",
      },
    ],
    resultType: "Von Mises stress",
  };
}

export default {
  id: "tie-patch-test",
  name: "Tie patch test",
  quantity: "stress uniformity σmax / σmin",
  unit: "",
  reference: 1,
  referenceLabel: "uniform σ (exact)",
  tolPct: 0.01,
  readout: { field: "Ux", stat: "Max" },
  // The displacement, not the stress: the stress is uniform to round-off, so a
  // colour scale stretched over its range would paint noise.
  page: {
    summary:
      "Uniform tension across a tie between non-matching meshes. The exact answer is reproduced to round-off.",
    model:
      "Block of length L, W × H section, in two bodies meshed 3 × 3 and 4 × 4 across, tied at x = L/2.",
    inputs: [
      ["L", L, "mm"],
      ["W × H", `${W} × ${H}`, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["σ", sigma, "MPa"],
    ],
    supports: "Symmetry: Ux = 0 on x = 0, Uy = 0 on y = 0, Uz = 0 on z = 0.",
    loads: "σ·W·H in +x as a force on the x = L face.",
    measured:
      "Largest over smallest element von Mises stress, over every element of both bodies.",
    mesh: `${DIV_A.join(" × ")} and ${DIV_B.join(" × ")} grids, tied`,
    source: "patch test (Irons); Puso (2004)",
    ties: true,
  },
  model() {
    return patchModel(this.name);
  },
  measure(model, result) {
    const vm = result.von_mises;
    return Math.max(...vm) / Math.min(...vm);
  },
  // The whole displacement field against the exact one, the stress range, and
  // the stress range of the same model tied node-to-surface instead.
  extras(model, result, solve) {
    const d = result.displacements;
    const scale = sigma / E;
    let err = 0,
      peak = 0;
    model.mesh.vertices.forEach(([x, y, z], i) => {
      const exact = [scale * x, -nu * scale * y, -nu * scale * z];
      for (let c = 0; c < 3; c++) {
        err = Math.max(err, Math.abs(d[3 * i + c] - exact[c]));
        peak = Math.max(peak, Math.abs(exact[c]));
      }
    });
    const vm = result.von_mises;
    const projected = solveModel(solve, {
      ...model,
      tieFormulation: "projection",
    }).von_mises;
    return {
      displacementErrPct: (100 * err) / peak,
      stressMin: Math.min(...vm),
      stressMax: Math.max(...vm),
      projectionStressMin: Math.min(...projected),
      projectionStressMax: Math.max(...projected),
    };
  },
};

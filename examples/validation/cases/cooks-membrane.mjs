// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Cook's membrane — the standard combined bending + shear distortion benchmark.
//
//   Tapered panel (0,0)-(48,44)-(48,60)-(0,44), clamped on x=0, a uniformly
//   distributed vertical shear F on the right edge x=48. E = 1, ν = 1/3, unit
//   thickness, F = 1 (all dimensionless). Reference: the converged vertical
//   displacement of the top-right corner (48, 60) ≈ 23.9 (Cook 1974; widely
//   reported plane-stress value).
//
// We model a thin 3D slab (one element through the thickness), so the panel is
// close to plane stress. The case is a regression check: refining moves the
// result past 23.9 (see the convergence study).

import { cookMembraneMesh, nodesWhere } from "../lib/mesh.mjs";

const E = 1.0;
const nu = 1 / 3;
const t = 1.0; // thin slab ⇒ plane-stress-like
const F = 1.0; // total shear load
const N = 16; // elements along each in-plane edge

/** The panel on an n × n in-plane grid, one element through the thickness. */
export function cookModel(title, n, order) {
  const m = cookMembraneMesh(n, n, t);
  return {
    title,
    mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
    material: {
      name: "Membrane",
      young_modulus: E,
      poisson_ratio: nu,
      density: 1,
    },
    order,
    support: {
      nodes: nodesWhere(m.vertices, (x) => x <= 1e-9),
      label: "Clamped edge x = 0",
    },
    load: {
      kind: "force",
      axis: 1,
      value: F,
      nodes: nodesWhere(m.vertices, (x) => x >= 48 - 1e-9),
      label: "Shear load (+Y)",
    },
    resultType: "Uy",
  };
}

/** Mean vertical deflection of the two nodes at the corner (48, 60). */
export function cookCorner(model, result) {
  const corner = nodesWhere(
    model.mesh.vertices,
    (x, y) => x >= 48 - 1e-9 && y >= 60 - 1e-9,
  );
  return (
    corner.reduce((s, v) => s + result.displacements[3 * v + 1], 0) /
    corner.length
  );
}

export default {
  id: "cooks-membrane",
  name: "Cook's membrane",
  quantity: "top-corner deflection",
  unit: "",
  reference: 23.9,
  referenceLabel: "converged ≈ 23.9",
  tolPct: 6,
  readout: { field: "Uy", stat: "Max" },
  figure: { view: [-0.15, -0.1, -1], unit: "" },
  page: {
    summary:
      "Tapered, skewed cantilever in shear. A standard distortion benchmark, dimensionless.",
    model: "Trapezoid (0, 0)–(48, 44)–(48, 60)–(0, 44), thickness t.",
    inputs: [
      ["t", t, ""],
      ["E", E, ""],
      ["ν", nu, ""],
      ["F", F, ""],
    ],
    supports: "x = 0 face fixed (Ux, Uy, Uz).",
    loads: "F in +y as a force on the x = 48 face.",
    measured: "y-displacement of the corner (48, 60).",
    mesh: `${N} × ${N} grid, 1 through t`,
    source: "Cook (1974)",
    grid: [N, N, 1],
    note: "Finer meshes move past the reference (see the convergence study): a regression check, not evidence of accuracy.",
  },
  model() {
    return cookModel(this.name, N, 1);
  },
  measure: cookCorner,
};

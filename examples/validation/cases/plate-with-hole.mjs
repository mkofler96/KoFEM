// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Plate with a central circular hole — the Kirsch stress-concentration problem.
//
//   A wide plate (half-width b ≫ hole radius a) in uniaxial tension σ. At the
//   hole edge transverse to the load the stress peaks at  σ_max = Kt·σ  with the
//   theoretical concentration factor  Kt = 3  for an infinite plate.
//
// This is a stress-driven case, so it is the hardest to nail with linear hexes
// (constant stress per element) — expect a few percent off, not the sub-percent
// agreement of the displacement cases. The tolerance band reflects that.
//
// Reference: Kirsch (1898); Timoshenko & Goodier, "Theory of Elasticity",
// stress around a circular hole in a plate.

import { plateWithHoleMesh, nodesWhere } from "../lib/mesh.mjs";
import { STEEL } from "../lib/app-model.mjs";

const E = STEEL.young_modulus; // MPa
const nu = STEEL.poisson_ratio;
const a = 1000, // hole radius (mm)
  b = 10000, // plate half-width (mm) — a/b = 0.1 ⇒ ≈ infinite-plate Kt
  t = 500; // thickness (mm)
const sigma = 100; // applied gross tension (MPa)
const NR = 12, // element rings from the hole to the outer edge
  NTH = 64, // elements around the hole
  GRADE = 2; // ring spacing ∝ s^GRADE, clustered at the hole

// The O-grid, for the case page's analysis of where the peak is sampled.
export const plateMesh = { a, b, nr: NR, nth: NTH, grade: GRADE };

export default {
  id: "plate-with-hole",
  name: "Plate with a hole",
  quantity: "stress-concentration factor Kt",
  unit: "",
  reference: 3.0,
  referenceLabel: "Kt = 3 (infinite plate)",
  tolPct: 15,
  readout: { field: "Ux", stat: "Max" },
  // The stress near the hole, seen face-on, undeformed.
  figure: {
    field: "vonMises",
    view: [0, 0, -1],
    deform: false,
    focus: { center: [0, 0, 250], half: 3200, aspect: 0.6 },
  },
  page: {
    summary:
      "Kirsch's stress concentration at a hole. The one stress-based case, hence the wider band.",
    model:
      "Square plate of half-width b and thickness t, central hole of radius a.",
    inputs: [
      ["a", a, "mm"],
      ["b", b, "mm"],
      ["t", t, "mm"],
      ["E", E, "MPa"],
      ["ν", nu, ""],
      ["σ", sigma, "MPa"],
    ],
    supports: "x = −b face fixed (Ux, Uy, Uz).",
    loads: "σ·2b·t in +x as a force on the x = +b face.",
    measured:
      "Peak element-centre von Mises stress around the hole, divided by σ.",
    mesh: `O-grid, ${NR} rings × ${NTH} around the hole, 1 through t`,
    source: "Kirsch (1898); Timoshenko & Goodier",
  },
  model() {
    const m = plateWithHoleMesh(a, b, t, NR, NTH, GRADE);
    return {
      title: this.name,
      mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
      material: STEEL,
      order: 1,
      support: {
        nodes: nodesWhere(m.vertices, (x) => x <= -b + 1e-6),
        label: "Fixed edge x = −b",
      },
      load: {
        kind: "force",
        axis: 0,
        value: sigma * (2 * b * t), // gross axial force
        nodes: nodesWhere(m.vertices, (x) => x >= b - 1e-6),
        label: "Tension (+X)",
      },
      resultType: "Von Mises stress",
    };
  },
  // Peak von Mises sits in the hole-ring elements (the first NTH hexes).
  measure(model, result) {
    let peak = 0;
    for (let e = 0; e < NTH; e++) peak = Math.max(peak, result.von_mises[e]);
    return peak / sigma; // Kt
  },
};

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Definitions for the interactive examples shown at /examples/.
//
// Each example is a complete, self-contained KoFEM model: a structured hex
// mesh, one fixed face, and one single-direction force applied over another
// face. Because the load is a single force over a face, it maps exactly onto a
// KoFEM "load group" (total force divided equally among the face nodes — the
// same distribution rebuildLoads performs in the app), so the .vtu we emit
// reopens in KoFEM web with identical boundary conditions.
//
// These reuse the validation mesh generators so the geometry and physics match
// the benchmarks in examples/validation/.

import {
  boxHexMesh,
  plateWithHoleMesh,
  cookMembraneMesh,
  nodesWhere,
} from "../validation/lib/mesh.mjs";

const STEEL = { young_modulus: 210e9, poisson_ratio: 0.3, density: 7850 };

function avg(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ── Axial bar ─────────────────────────────────────────────────────────────────
const axialBar = (() => {
  const E = STEEL.young_modulus,
    L = 1.0,
    W = 0.1,
    H = 0.1,
    P = 1.0e6;
  const m = boxHexMesh(L, W, H, 20, 4, 4);
  return {
    id: "axial-bar",
    title: "Axial bar in tension",
    blurb:
      "A prismatic steel bar fixed at one end and pulled by a uniform axial force. The tip extension matches the closed-form δ = P·L / (E·A).",
    mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
    material: { name: "Steel", ...STEEL },
    fixed: nodesWhere(m.vertices, (x) => x <= 1e-9),
    load: {
      dof: 0,
      totalForce: P,
      nodes: nodesWhere(m.vertices, (x) => x >= L - 1e-9),
      label: "Axial load (+X)",
    },
    quantity: "tip extension δ",
    unit: "m",
    reference: (P * L) / (E * (W * H)),
    referenceLabel: "δ = P·L / (E·A)",
    feValue: (r, loaded) => avg(loaded.map((v) => r.displacements[v * 3])),
  };
})();

// ── Cantilever beam ───────────────────────────────────────────────────────────
const cantilever = (() => {
  const E = STEEL.young_modulus,
    L = 1.0,
    b = 0.1,
    h = 0.1,
    P = 1.0e4;
  const I = (b * h ** 3) / 12;
  const m = boxHexMesh(L, b, h, 40, 4, 4);
  return {
    id: "cantilever-beam",
    title: "Cantilever beam under tip load",
    blurb:
      "A beam clamped at the wall with a transverse load over its free-end face — the classic Euler–Bernoulli bending check, δ = P·L³ / (3·E·I).",
    mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
    material: { name: "Steel", ...STEEL },
    fixed: nodesWhere(m.vertices, (x) => x <= 1e-9),
    load: {
      dof: 1,
      totalForce: -P,
      nodes: nodesWhere(m.vertices, (x) => x >= L - 1e-9),
      label: "Tip load (−Y)",
    },
    quantity: "tip deflection δ",
    unit: "m",
    reference: -(P * L ** 3) / (3 * E * I),
    referenceLabel: "δ = P·L³ / (3·E·I)",
    feValue: (r, loaded) => avg(loaded.map((v) => r.displacements[v * 3 + 1])),
  };
})();

// ── Plate with a hole ─────────────────────────────────────────────────────────
const plateWithHole = (() => {
  const a = 1.0,
    b = 10.0,
    t = 0.5,
    sigma = 100e6;
  const m = plateWithHoleMesh(a, b, t, 12, 64, 2);
  const P = sigma * (2 * b * t);
  return {
    id: "plate-with-hole",
    title: "Plate with a hole",
    blurb:
      "A wide plate in uniaxial tension with a central circular hole. The stress peaks at the hole edge transverse to the load, approaching Kirsch's Kt = 3.",
    mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
    material: { name: "Steel", ...STEEL },
    fixed: nodesWhere(m.vertices, (x) => x <= -b + 1e-6),
    load: {
      dof: 0,
      totalForce: P,
      nodes: nodesWhere(m.vertices, (x) => x >= b - 1e-6),
      label: "Tension (+X)",
    },
    quantity: "stress-concentration factor Kt",
    unit: "",
    reference: 3.0,
    referenceLabel: "Kt = 3 (Kirsch)",
    // Peak von Mises sits in the hole-ring elements (the first nth hexes).
    feValue: (r) => {
      let peak = 0;
      for (let e = 0; e < m.nth; e++) peak = Math.max(peak, r.von_mises[e]);
      return peak / sigma;
    },
    resultType: "Von Mises stress",
  };
})();

// ── Cook's membrane ───────────────────────────────────────────────────────────
const cooksMembrane = (() => {
  const t = 1.0,
    F = 1.0;
  const m = cookMembraneMesh(16, 16, t);
  return {
    id: "cooks-membrane",
    title: "Cook's membrane",
    blurb:
      "A skewed, tapered cantilever clamped on the left and loaded in shear on the right — the standard combined bending-and-shear distortion benchmark.",
    mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
    material: {
      name: "Membrane",
      young_modulus: 1.0,
      poisson_ratio: 1 / 3,
      density: 1,
    },
    fixed: nodesWhere(m.vertices, (x) => x <= 1e-9),
    load: {
      dof: 1,
      totalForce: F,
      nodes: nodesWhere(m.vertices, (x) => x >= 48 - 1e-9),
      label: "Shear load (+Y)",
    },
    quantity: "top-corner deflection",
    unit: "",
    reference: 23.9,
    referenceLabel: "converged ≈ 23.9",
    feValue: (r) => {
      const corner = nodesWhere(
        m.vertices,
        (x, y) => x >= 48 - 1e-9 && y >= 60 - 1e-9,
      );
      return avg(corner.map((v) => r.displacements[v * 3 + 1]));
    },
  };
})();

export default [axialBar, cantilever, plateWithHole, cooksMembrane];

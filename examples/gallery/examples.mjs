// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Definitions for the interactive examples shown at /examples/.
//
// Each example is a complete, self-contained KoFEM model: a structured hex
// mesh, one fixed face, and one single-direction force (or moment) applied over
// another face. Forces map onto a KoFEM "load group" and are solved exactly as
// the app does — a work-equivalent surface traction over the loaded face
// (rebuildSurfaceLoads), not an equal nodal split — so the .vtu we emit reopens
// in KoFEM web with an identical solved field.
//
// Units follow KoFEM's canonical system: N · mm · MPa · tonne. Lengths are in
// mm, forces in N, moments in N·mm, stresses / E in MPa, density in t/mm³.
// Steel: E = 210 GPa = 210000 MPa, ρ = 7850 kg/m³ = 7.85e-9 t/mm³ — the same
// material the app seeds by default (web/src/store/modelStore.ts).
//
// These reuse the validation mesh generators so the geometry and physics match
// the benchmarks in examples/validation/ (those cases are stated in SI; here the
// identical problems are expressed in the app's mm/MPa system).

import {
  boxHexMesh,
  plateWithHoleMesh,
  cookMembraneMesh,
  nodesWhere,
} from "../validation/lib/mesh.mjs";

const STEEL = { young_modulus: 210000, poisson_ratio: 0.3, density: 7.85e-9 };

function avg(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ── Axial bar ─────────────────────────────────────────────────────────────────
const axialBar = (() => {
  const E = STEEL.young_modulus,
    L = 1000, // mm
    W = 100,
    H = 100, // mm
    P = 1.0e6; // N
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
    unit: "mm",
    reference: (P * L) / (E * (W * H)),
    referenceLabel: "δ = P·L / (E·A)",
    feValue: (r, loaded) => avg(loaded.map((v) => r.displacements[v * 3])),
  };
})();

// ── Cantilever beam ───────────────────────────────────────────────────────────
const cantilever = (() => {
  const E = STEEL.young_modulus,
    L = 1000, // mm
    b = 100,
    h = 100, // mm
    P = 1.0e4; // N
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
    unit: "mm",
    reference: -(P * L ** 3) / (3 * E * I),
    referenceLabel: "δ = P·L³ / (3·E·I)",
    feValue: (r, loaded) => avg(loaded.map((v) => r.displacements[v * 3 + 1])),
  };
})();

// ── Square beam under torsion ─────────────────────────────────────────────────
const beamTorsion = (() => {
  const E = STEEL.young_modulus,
    nu = STEEL.poisson_ratio,
    L = 1000, // mm
    b = 100, // square side (mm)
    T = 1.0e6; // N·mm about the beam axis (x) — 1000 N·m
  const G = E / (2 * (1 + nu));
  // Square-section torsion constant K = β·b⁴ (Roark's b/a→1 limit, β ≈ 0.1408).
  const beta = 1 / 3 - 0.21 * (1 - 1 / 12);
  const K = beta * b ** 4;
  const m = boxHexMesh(L, b, b, 20, 6, 6);
  const tip = nodesWhere(m.vertices, (x) => x >= L - 1e-9);
  // Cross-section centroid of the loaded face = the torsion axis.
  const cy = avg(tip.map((v) => m.vertices[v][1]));
  const cz = avg(tip.map((v) => m.vertices[v][2]));
  return {
    id: "beam-torsion",
    title: "Square beam under torsion",
    blurb:
      "The same cantilever beam, now twisted by a torque about its own axis instead of bent. The free-end rotation matches Saint-Venant torsion of a square section, θ = T·L / (G·K).",
    mesh: { vertices: m.vertices, hexahedra: m.hexahedra },
    material: { name: "Steel", ...STEEL },
    fixed: nodesWhere(m.vertices, (x) => x <= 1e-9),
    // dof 3 = moment about x (Mx); the app's rebuildLoads turns this into the
    // tangential ∝ r couple, and the generator applies the same conversion.
    load: {
      dof: 3,
      totalForce: T,
      nodes: tip,
      label: "Torque (about X)",
    },
    quantity: "angle of twist θ",
    unit: "rad",
    reference: (T * L) / (G * K),
    referenceLabel: "θ = T·L / (G·K)",
    // θ = mean of (r × u)_x / r² over the free-end face.
    feValue: (r, loaded) => {
      let s = 0,
        n = 0;
      for (const v of loaded) {
        const y = m.vertices[v][1] - cy,
          z = m.vertices[v][2] - cz;
        const r2 = y * y + z * z;
        if (r2 < 1e-12) continue;
        const uy = r.displacements[v * 3 + 1],
          uz = r.displacements[v * 3 + 2];
        s += (y * uz - z * uy) / r2;
        n++;
      }
      return s / n;
    },
  };
})();

// ── Plate with a hole ─────────────────────────────────────────────────────────
const plateWithHole = (() => {
  const a = 1000, // hole radius (mm)
    b = 10000, // plate half-width (mm)
    t = 500, // thickness (mm)
    sigma = 100; // remote tension (MPa)
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
// A normalized benchmark: geometry (48/44/60), E = 1 and F = 1 are the canonical
// dimensionless values, and the converged tip deflection ≈ 23.9 is tied to them.
// It stays unitless rather than being rescaled into mm/MPa — the result is the
// same dimensionless 23.9 regardless of how the units are read.
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

export default [
  axialBar,
  cantilever,
  beamTorsion,
  plateWithHole,
  cooksMembrane,
];

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Idiot-proof regression test for single-DOF (per-component) constraints.
//
// THE BUG THIS GUARDS: the UI lets you constrain a node in just one direction
// (e.g. Ux only), but the solver used to promote any translational constraint
// to a full pin of all three components. This test proves a node constrained in
// ONLY Ux is still free to move in Y and Z.
//
// Setup: an eighth-symmetry model of uniaxial tension. Single-DOF rollers on the
// three symmetry planes — Ux=0 on x=0, Uy=0 on y=0, Uz=0 on z=0 — and a tension
// load on the x=L face. The exact solution is a linear displacement field
//   ux = εx·x,  uy = −ν·εx·y,  uz = −ν·εx·z,   εx = σ/E,
// which trilinear hexes reproduce. The (0,W,H) corner lies on the x=0 plane
// ONLY, so it is constrained in Ux alone and must contract by −ν·εx·W in y and
// −ν·εx·H in z. A full-fixity bug would pin it and leave both at zero.
//
// Runs against the freshly built WASM in CI. On the committed binary (before a
// rebuild with the engine.cpp `fixed_dofs` support) it is EXPECTED to fail —
// fixed_dofs is ignored, the model is unconstrained, and the solve blows up.
// That failure is the signal to run scripts/build-wasm.sh.

import { loadSolver } from "./lib/solver.mjs";
import { boxHexMesh, nodesWhere, distributeForce } from "./lib/mesh.mjs";

const E = 200e9;
const nu = 0.3;
const L = 4,
  W = 1,
  H = 1;
const sigma = 2e8; // applied tension (Pa)
const P = sigma * W * H;
const epsX = sigma / E;
const expUy = -nu * epsX * W; // Poisson contraction at y = W
const expUz = -nu * epsX * H; // Poisson contraction at z = H

const m = boxHexMesh(L, W, H, 4, 2, 2);

// Symmetry-plane rollers, all single-DOF. Union the components per node so the
// shared edges/corners carry several (e.g. the origin gets Ux+Uy+Uz).
const dofsByNode = new Map();
const addDof = (ids, dof) =>
  ids.forEach((i) => {
    if (!dofsByNode.has(i)) dofsByNode.set(i, new Set());
    dofsByNode.get(i).add(dof);
  });
addDof(
  nodesWhere(m.vertices, (x) => x <= 1e-9),
  0,
); // x=0 → Ux
addDof(
  nodesWhere(m.vertices, (x, y) => y <= 1e-9),
  1,
); // y=0 → Uy
addDof(
  nodesWhere(m.vertices, (x, y, z) => z <= 1e-9),
  2,
); // z=0 → Uz
const fixed_dofs = [...dofsByNode].map(([vertex, s]) => ({
  vertex,
  dofs: [...s].sort(),
}));

const loaded = nodesWhere(m.vertices, (x) => x >= L - 1e-9);
const point_loads = distributeForce(loaded, [P, 0, 0]);

const solve = await loadSolver();
const r = solve(
  { vertices: m.vertices, hexahedra: m.hexahedra },
  { young_modulus: E, poisson_ratio: nu, density: 7850 },
  { fixed_vertices: [], fixed_dofs, point_loads },
  1,
);

const d = (v, c) => r.displacements[v * 3 + c];
// Discriminator: the (0, W, H) corner — on the x=0 plane only ⇒ Ux-only.
const disc = nodesWhere(
  m.vertices,
  (x, y, z) => x <= 1e-9 && y >= W - 1e-9 && z >= H - 1e-9,
)[0];
const uxFace = loaded.reduce((s, v) => s + d(v, 0), 0) / loaded.length; // ≈ εx·L

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const finite = r.displacements.every(Number.isFinite);
check("solve produced finite displacements", finite, "");

if (finite) {
  // The Ux-only node is actually held in x.
  check(
    "discriminator node is constrained in Ux (ux ≈ 0)",
    Math.abs(d(disc, 0)) < 1e-3 * Math.abs(uxFace),
    `ux=${d(disc, 0).toExponential(3)}`,
  );

  // THE DISCRIMINATOR: it is FREE in y and z and contracts under Poisson. A
  // full-fixity bug leaves these at zero, so "more than half the expected
  // contraction, with the right sign" cleanly separates fixed from free.
  check(
    "discriminator node is FREE in Uy (Poisson contraction, not pinned)",
    d(disc, 1) < 0.5 * expUy,
    `uy=${d(disc, 1).toExponential(3)} (expected ≈ ${expUy.toExponential(3)})`,
  );
  check(
    "discriminator node is FREE in Uz (Poisson contraction, not pinned)",
    d(disc, 2) < 0.5 * expUz,
    `uz=${d(disc, 2).toExponential(3)} (expected ≈ ${expUz.toExponential(3)})`,
  );

  // Physics sanity: the linear field matches theory.
  check(
    "uniaxial extension ux ≈ εx·L (±5%)",
    Math.abs((uxFace - epsX * L) / (epsX * L)) < 0.05,
    `ux=${uxFace.toExponential(3)} vs ${(epsX * L).toExponential(3)}`,
  );
  check(
    "Poisson contraction uy ≈ −ν·εx·W (±15%)",
    Math.abs((d(disc, 1) - expUy) / expUy) < 0.15,
    `uy=${d(disc, 1).toExponential(3)} vs ${expUy.toExponential(3)}`,
  );
}

console.log("\nSingle-DOF constraint test (engine.cpp fixed_dofs)\n");
let failed = 0;
for (const c of checks) {
  console.log(
    `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`,
  );
  if (!c.ok) failed++;
}

if (failed) {
  console.error(
    `\n${failed} check(s) FAILED. If this is the committed WASM, rebuild it with` +
      `\n  scripts/build-wasm.sh` +
      `\nso engine.cpp's fixed_dofs (single-DOF) support is compiled in.\n`,
  );
  process.exit(1);
}
console.log("\nPASS — single-DOF constraints are honored.\n");

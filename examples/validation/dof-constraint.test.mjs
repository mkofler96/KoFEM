// Idiot-proof regression test for single-DOF (per-component) constraints.
//
// THE BUG THIS GUARDS: the UI lets you constrain a node in just one direction
// (e.g. Ux only), but the solver used to promote any translational constraint
// to a full pin of all three components. This test proves a node constrained in
// ONLY Ux is still free to move in Y and Z.
//
// How: a single unit cube held by a statically-determinate 3-2-1 restraint made
// entirely of single-DOF constraints, pulled in +x. Under Poisson's effect a
// node fixed in Ux alone must contract in −y and −z. If the engine wrongly
// full-fixes it, that contraction is zero and the test fails.
//
// Runs against the freshly built WASM in CI. On the committed binary (before a
// rebuild with the engine.cpp `fixed_dofs` support) it is EXPECTED to fail —
// that is the signal to run scripts/build-wasm.sh.

import { loadSolver } from "./lib/solver.mjs";

const E = 200e9;
const nu = 0.3;
const sigma = 2e8; // applied tension (Pa) on a 1 m unit cube ⇒ A = 1 m²
const P = sigma; // total force = σ·A

// Unit cube. Bottom face CCW then top face — MFEM AddHex order.
const N = {
  n0: [0, 0, 0],
  n1: [1, 0, 0],
  n2: [1, 1, 0],
  n3: [0, 1, 0],
  n4: [0, 0, 1],
  n5: [1, 0, 1],
  n6: [1, 1, 1],
  n7: [0, 1, 1],
};
const vertices = [N.n0, N.n1, N.n2, N.n3, N.n4, N.n5, N.n6, N.n7];
const hexahedra = [[0, 1, 2, 3, 4, 5, 6, 7]];

// 3-2-1 restraint on the x=0 face, all single-DOF:
//   Ux=0 on all four x=0 nodes (symmetry plane) → kills Tx, Ry, Rz
//   n0 also Uy,Uz → kills Ty, Tz;  n3 also Uz → kills Rx
// Nodes 4 and 7 are held in Ux ONLY: they must stay free in y and z.
const fixed_dofs = [
  { vertex: 0, dofs: [0, 1, 2] },
  { vertex: 3, dofs: [0, 2] },
  { vertex: 4, dofs: [0] }, // Ux only
  { vertex: 7, dofs: [0] }, // Ux only ← discriminator node
];

// Pull the x=1 face in +x.
const point_loads = [1, 2, 5, 6].map((vertex) => ({
  vertex,
  force: [P / 4, 0, 0],
}));

const solve = await loadSolver();
const r = solve(
  { vertices, hexahedra },
  { young_modulus: E, poisson_ratio: nu, density: 7850 },
  { fixed_vertices: [], fixed_dofs, point_loads },
  1,
);

const d = (v, c) => r.displacements[v * 3 + c];
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

// Sanity: solve produced finite numbers (a singular/unconstrained system —
// what you get if fixed_dofs is ignored — yields NaN or garbage here).
const finite = r.displacements.every(Number.isFinite);
check("solve produced finite displacements", finite, "");

if (finite) {
  const uxFace = (d(1, 0) + d(2, 0) + d(5, 0) + d(6, 0)) / 4;
  const uxExpected = sigma / E; // ε_x · L = σ/E (L = 1)
  const poissonExpected = -nu * (sigma / E);

  // 1. The Ux-only node is actually held in x.
  check(
    "node 7 is constrained in Ux (ux ≈ 0)",
    Math.abs(d(7, 0)) < 1e-3 * Math.abs(uxFace),
    `ux(n7)=${d(7, 0).toExponential(3)}`,
  );

  // 2. THE DISCRIMINATOR: node 7, constrained in Ux only, is free in Y and Z and
  //    contracts under Poisson. A full-fixity bug would leave these at zero.
  check(
    "node 7 is FREE in Uy (Poisson contraction, not pinned)",
    d(7, 1) < 0.5 * poissonExpected,
    `uy(n7)=${d(7, 1).toExponential(3)} (expected ≈ ${poissonExpected.toExponential(3)})`,
  );
  check(
    "node 7 is FREE in Uz (Poisson contraction, not pinned)",
    d(7, 2) < 0.5 * poissonExpected,
    `uz(n7)=${d(7, 2).toExponential(3)} (expected ≈ ${poissonExpected.toExponential(3)})`,
  );

  // 3. Physics sanity: uniaxial extension and Poisson contraction are right.
  check(
    "uniaxial extension ux ≈ σ/E (±5%)",
    Math.abs((uxFace - uxExpected) / uxExpected) < 0.05,
    `ux=${uxFace.toExponential(3)} vs ${uxExpected.toExponential(3)}`,
  );
  check(
    "Poisson contraction uy(n7) ≈ −ν·σ/E (±15%)",
    Math.abs((d(7, 1) - poissonExpected) / poissonExpected) < 0.15,
    `uy=${d(7, 1).toExponential(3)} vs ${poissonExpected.toExponential(3)}`,
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

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Idiot-proof regression test for MULTIPLE surface loads in one solve (KOF-216).
//
// THE BUG THIS GUARDS: apply_surface_loads used to give each load its own
// boundary attribute and tag its elements in load order. A boundary element
// carries exactly ONE attribute, so wherever two loads covered the same element
// the later one overwrote the earlier one's tag — and the overwritten load, now
// matching no marked element, was integrated over nothing and vanished. Two
// equal forces on the same flange face produced the deflection of ONE, with no
// warning anywhere.
//
// Setup: a cantilever box clamped at x=0, with tip and top faces available to
// load. Linear elasticity is linear, so superposition is exact and gives an
// independent reference for every combination:
//
//   1. Disjoint loads      — solve(A+B) == solve(A) + solve(B).
//   2. Coincident loads    — two F/2 loads on the SAME faces == one F. This is
//                            the case the old attribute scheme dropped.
//   3. Partial overlap     — loads sharing only part of their faces, checked
//                            against the sum of the individual solves.
//
// A fourth check covers the other half of KOF-216: several Dirichlet groups and
// NO load at all must still drive the model (a prescribed displacement is a
// driving action on its own).
//
// Run: node examples/validation/multiple-loads.test.mjs

import { loadSolver } from "./lib/solver.mjs";
import { boxHexMesh, nodesWhere } from "./lib/mesh.mjs";

const E = 200e9;
const nu = 0.3;
const L = 4,
  W = 1,
  H = 1;
const nx = 4,
  ny = 2,
  nz = 2;

const m = boxHexMesh(L, W, H, nx, ny, nz);
const mesh = { vertices: m.vertices, hexahedra: m.hexahedra };
const mat = { young_modulus: E, poisson_ratio: nu, density: 7850 };
const clamped = nodesWhere(m.vertices, (x) => x <= 1e-9);

// Quad boundary faces of the x=L (tip) and z=H (top) planes, in the node
// ordering the engine's generated boundary elements use — matching is by vertex
// SET, so only the grouping matters.
const tipFaces = [];
for (let j = 0; j < ny; j++)
  for (let k = 0; k < nz; k++)
    tipFaces.push([
      m.nid(nx, j, k),
      m.nid(nx, j + 1, k),
      m.nid(nx, j + 1, k + 1),
      m.nid(nx, j, k + 1),
    ]);
const topFaces = [];
for (let i = 0; i < nx; i++)
  for (let j = 0; j < ny; j++)
    topFaces.push([
      m.nid(i, j, nz),
      m.nid(i + 1, j, nz),
      m.nid(i + 1, j + 1, nz),
      m.nid(i, j + 1, nz),
    ]);

const solve = await loadSolver();
const run = (bcs) =>
  solve(mesh, mat, { fixed_vertices: clamped, ...bcs }, 1).displacements;

// L2 norm of the difference between two displacement fields, relative to the
// norm of the reference — one number that catches a dropped load anywhere in
// the model, not just at a probe node.
function relDiff(a, ref) {
  let num = 0,
    den = 0;
  for (let i = 0; i < ref.length; i++) {
    num += (a[i] - ref[i]) ** 2;
    den += ref[i] ** 2;
  }
  return Math.sqrt(num / den);
}
const sum = (a, b) => a.map((v, i) => v + b[i]);

// Two solves of the same physics differ only by CG convergence: each stops at a
// 1e-6 relative residual (run_cg_solve), so their displacement fields agree to
// ~1e-8, not to machine precision. SAME is set well above that noise floor and
// still five orders of magnitude below the signal a dropped load produces — a
// missing load costs a FRACTION of the answer (0.5 for one of two equal loads),
// never 1e-5. DIFFERENT is the other side of the same gap: a change that is real
// rather than numerical.
const SAME = 1e-5;
const DIFFERENT = 1e-2;

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const FZ = -1e6;
const FY = -5e5;

// ── 1. Disjoint loads superpose ──────────────────────────────────────────────
const tipDown = { type: "force", faces: tipFaces, force: [0, 0, FZ] };
const topSide = { type: "force", faces: topFaces, force: [0, FY, 0] };
const uTip = run({ surface_loads: [tipDown] });
const uTop = run({ surface_loads: [topSide] });
const uBoth = run({ surface_loads: [tipDown, topSide] });
check(
  "two loads on DISJOINT faces both act (== superposition)",
  relDiff(uBoth, sum(uTip, uTop)) < SAME,
  `relative L2 difference ${relDiff(uBoth, sum(uTip, uTop)).toExponential(2)}`,
);

// ── 2. Coincident loads both act ─────────────────────────────────────────────
// THE DISCRIMINATOR: two F/2 loads on the SAME faces must equal one F. The
// buggy binary keeps only the last, giving exactly half — so this separates
// "both applied" from "one silently dropped" by a factor of two.
const half = { type: "force", faces: tipFaces, force: [0, 0, FZ / 2] };
const uTwoHalves = run({ surface_loads: [half, half] });
check(
  "two loads on the SAME faces both act (F/2 + F/2 == F)",
  relDiff(uTwoHalves, uTip) < SAME,
  `relative L2 difference ${relDiff(uTwoHalves, uTip).toExponential(2)}`,
);

// A pressure and a force on the same face is the everyday version of the same
// overlap: both must survive.
const tipPressure = { type: "pressure", faces: tipFaces, pressure: 5e7 };
const uPressure = run({ surface_loads: [tipPressure] });
const uMixed = run({ surface_loads: [tipDown, tipPressure] });
check(
  "a force and a pressure on the SAME faces both act",
  relDiff(uMixed, sum(uTip, uPressure)) < SAME,
  `relative L2 difference ${relDiff(uMixed, sum(uTip, uPressure)).toExponential(2)}`,
);

// ── 3. Partially overlapping loads ───────────────────────────────────────────
// The half of the top face nearest the tip, so the two selections share
// elements without either containing the other.
const topOuter = topFaces.filter((_f, idx) => idx >= topFaces.length / 2);
const overlapA = { type: "force", faces: topFaces, force: [0, FY, 0] };
const overlapB = { type: "force", faces: topOuter, force: [0, 0, FZ / 4] };
const uA = run({ surface_loads: [overlapA] });
const uB = run({ surface_loads: [overlapB] });
const uOverlap = run({ surface_loads: [overlapA, overlapB] });
check(
  "PARTIALLY overlapping loads both act in full",
  relDiff(uOverlap, sum(uA, uB)) < SAME,
  `relative L2 difference ${relDiff(uOverlap, sum(uA, uB)).toExponential(2)}`,
);

// The opposite failure mode: a fix that de-duplicated overlapping loads into one
// would pass every check above and still be wrong. Listing B twice must deliver
// twice B's force, so the answer has to MOVE.
const uDoubleB = run({
  surface_loads: [overlapA, overlapB, overlapB],
});
check(
  "overlapping loads are not silently merged (adding B twice changes the answer)",
  relDiff(uDoubleB, uOverlap) > DIFFERENT,
  `relative L2 difference ${relDiff(uDoubleB, uOverlap).toExponential(2)}`,
);

// ── 4. Several Dirichlet groups, NO load ─────────────────────────────────────
// A prescribed displacement drives the model on its own, alongside any number
// of homogeneous groups: a full clamp on x=0, a roller on y=0, and a prescribed
// Ux on x=L, with no load anywhere.
const delta = 0.004;
const rollers = nodesWhere(m.vertices, (x, y) => y <= 1e-9).map((vertex) => ({
  vertex,
  dofs: [1],
}));
const driven = nodesWhere(m.vertices, (x) => x >= L - 1e-9);
const uDirichlet = run({
  fixed_dofs: rollers,
  prescribed_dofs: driven.map((vertex) => ({ vertex, dof: 0, value: delta })),
});
const uxFace =
  driven.reduce((s, v) => s + uDirichlet[3 * v], 0) / driven.length;
check(
  "three Dirichlet groups and NO load: the prescribed value drives the model",
  Math.abs((uxFace - delta) / delta) < 0.05,
  `ux=${uxFace.toExponential(3)} vs δ=${delta.toExponential(3)}`,
);

// ── Report ───────────────────────────────────────────────────────────────────
console.log("\nMultiple-loads test (solve_mfem.cpp apply_surface_loads)\n");
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
      `\nso solve_mfem.cpp's overlapping-load attribute grouping is compiled in.\n`,
  );
  process.exit(1);
}
console.log("\nPASS — every surface load in a solve is applied.\n");

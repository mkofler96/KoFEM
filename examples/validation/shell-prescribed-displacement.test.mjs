// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Regression test for non-zero prescribed displacements on SHELL models (KOF-210).
// Shell counterpart of prescribed-displacement.test.mjs, which covers the solid
// (MFEM) path.
//
// THE BUG THIS GUARDS: the shell formulation's boundary conditions used to be
// homogeneous-only — ShellInput.fixed_dofs are "constrained to zero" and there
// was no inhomogeneous counterpart to the solid path's prescribed_dofs. A model
// driven by a prescribed displacement therefore either refused to run (explicit
// CTRIA3) or, worse, silently pinned the value to zero and returned an all-zero
// field that looks like a converged answer (auto-shell / coupled). Thin-walled
// parts land on the shell path automatically, so this was easy to hit without
// ever choosing a shell idealisation.
//
// Setup: in-plane (membrane) extension of a flat strip [0,L]x[0,b] in the z = 0
// plane, driven by displacement only, with no applied load. Symmetry rollers
// Ux = 0 on x = 0 and Uy = 0 on y = 0, a NON-ZERO prescribed Ux = δ on the x = L
// edge, and the out-of-plane DOFs (w, θx, θy) plus the stiffness-free drilling
// DOF θz pinned everywhere so this is the pure CST membrane problem. The exact
// solution is the linear field
//   ux = εx·x,  uy = −ν·εx·y,   εx = δ/L,
// independent of E and t (a pure-displacement boundary-value problem), which the
// constant-strain triangle reproduces exactly. The x = L edge must reach ux ≈ δ;
// a binary without shell prescribed_dofs support leaves it at zero.
//
// Runs against the WASM engine the other validation tests use. On a binary built
// before the shell prescribed_dofs support it is EXPECTED to fail — either with
// the old refusal or with an all-zero field. That failure is the signal to
// rebuild with scripts/build-wasm.sh.

import { loadShellSolver } from "./lib/solver.mjs";
import { nodesWhere } from "./lib/mesh.mjs";

const nu = 0.3;
const E = 210e9; // result is E-independent; any positive value works
const t = 0.01;
const L = 1.0,
  b = 0.25;
const delta = 1e-4; // prescribed Ux on the x = L edge
const epsX = delta / L;
const expUySide = -nu * epsX * b; // Poisson contraction at y = b

// Structured triangle mesh of the strip, two triangles per cell.
const nx = 8,
  ny = 2;
const id = (i, j) => i * (ny + 1) + j;
const vertices = [];
for (let i = 0; i <= nx; i++)
  for (let j = 0; j <= ny; j++) vertices.push([(L * i) / nx, (b * j) / ny, 0]);
const triangles = [];
for (let i = 0; i < nx; i++)
  for (let j = 0; j < ny; j++) {
    triangles.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)]);
    triangles.push([id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
  }

// Zero-Dirichlet set, unioned per vertex: the out-of-plane and drilling DOFs
// everywhere (a flat plate loaded in its own plane has no bending action, and
// DKT+CST carries no drilling stiffness, so those would otherwise be singular),
// plus the two symmetry rollers.
const zeroByVertex = new Map();
const addZero = (ids, dofs) =>
  ids.forEach((i) => {
    if (!zeroByVertex.has(i)) zeroByVertex.set(i, new Set());
    for (const d of dofs) zeroByVertex.get(i).add(d);
  });
addZero(
  vertices.map((_v, i) => i),
  [2, 3, 4, 5],
);
addZero(
  nodesWhere(vertices, (x) => x <= 1e-9),
  [0],
); // x = 0 → Ux = 0
addZero(
  nodesWhere(vertices, (x, y) => y <= 1e-9),
  [1],
); // y = 0 → Uy = 0
const fixed_dofs = [...zeroByVertex].map(([vertex, s]) => ({
  vertex,
  dofs: [...s].sort((p, q) => p - q),
}));

// The driving condition: NON-ZERO prescribed Ux on the x = L edge, no load.
const driven = nodesWhere(vertices, (x) => x >= L - 1e-9);
const prescribed_dofs = driven.map((vertex) => ({
  vertex,
  dof: 0,
  value: delta,
}));

const solveShell = await loadShellSolver();
const r = solveShell(
  { vertices, triangles },
  { young_modulus: E, poisson_ratio: nu, thickness: t },
  { fixed_vertices: [], fixed_dofs, prescribed_dofs, point_loads: [] },
);

const d = (v, c) => r.displacements[v * 3 + c];
const uxEnd = driven.reduce((s, v) => s + d(v, 0), 0) / driven.length; // ≈ δ
// Discriminator vertex: on the driven edge AND at y = b, so it is free to
// contract under Poisson — the (L, b) corner.
const corner = nodesWhere(
  vertices,
  (x, y) => x >= L - 1e-9 && y >= b - 1e-9,
)[0];
// Midspan vertex on the symmetry line y = 0, where the linear field gives δ/2.
const mid = nodesWhere(
  vertices,
  (x, y) => Math.abs(x - L / 2) <= 1e-9 && y <= 1e-9,
)[0];

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const finite = r.displacements.every(Number.isFinite);
check("shell solve produced finite displacements", finite, "");

if (finite) {
  // THE DISCRIMINATOR: the prescribed value actually reaches the driven edge.
  // A binary without shell prescribed_dofs pins it to zero, so "within 1% of δ"
  // cleanly separates applied from discarded.
  check(
    "prescribed Ux is applied on the driven edge (ux ≈ δ, NOT zero)",
    Math.abs((uxEnd - delta) / delta) < 0.01,
    `ux=${uxEnd.toExponential(3)} vs δ=${delta.toExponential(3)}`,
  );

  // The CST reproduces the linear extension field exactly, so midspan lands on
  // δ/2 — proof the whole field is driven, not just the constrained edge.
  check(
    "midspan follows the linear extension field (ux ≈ δ/2)",
    Math.abs((d(mid, 0) - delta / 2) / (delta / 2)) < 0.01,
    `ux=${d(mid, 0).toExponential(3)} vs ${(delta / 2).toExponential(3)}`,
  );

  // The transverse contraction is a SOLVED unknown, so it proves the driven edge
  // is FREE in y rather than clamped: an implementation that folded the
  // prescribed BC into a full fix would return uy = 0 here.
  check(
    "driven edge is FREE in Uy and contracts under Poisson (not over-pinned)",
    Math.abs((d(corner, 1) - expUySide) / expUySide) < 0.05,
    `uy=${d(corner, 1).toExponential(3)} vs ${expUySide.toExponential(3)}`,
  );
}

console.log("\nShell prescribed-displacement test (KOF-210)\n");
let failed = 0;
for (const c of checks) {
  console.log(
    `  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? "  — " + c.detail : ""}`,
  );
  if (!c.ok) failed++;
}

if (failed) {
  console.error(
    `\n${failed} check(s) FAILED. If this is a stale WASM binary, rebuild it with` +
      `\n  scripts/build-wasm.sh` +
      `\nso shell_core's prescribed_dofs (inhomogeneous Dirichlet) support is compiled in.\n`,
  );
  process.exit(1);
}
console.log(
  "\nPASS — non-zero prescribed displacements are honored on shell models.\n",
);

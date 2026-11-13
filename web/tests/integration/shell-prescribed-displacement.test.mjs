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

import { beforeAll, describe, expect, test } from "bun:test";
import { loadShellSolver } from "../../../examples/validation/lib/solver.mjs";
import { nodesWhere } from "../../../examples/validation/lib/mesh.mjs";

const nu = 0.3;
const youngModulus = 210e9; // result is E-independent; any positive value works
const thickness = 0.01;
const length = 1.0,
  width = 0.25;
const delta = 1e-4; // prescribed Ux on the x = length edge
const epsX = delta / length;
const expUySide = -nu * epsX * width; // Poisson contraction at y = width

// Structured triangle mesh of the strip, two triangles per cell.
const nx = 8,
  ny = 2;
const id = (i, j) => i * (ny + 1) + j;
const vertices = [];
for (let i = 0; i <= nx; i++)
  for (let j = 0; j <= ny; j++)
    vertices.push([(length * i) / nx, (width * j) / ny, 0]);
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
const driven = nodesWhere(vertices, (x) => x >= length - 1e-9);
const prescribed_dofs = driven.map((vertex) => ({
  vertex,
  dof: 0,
  value: delta,
}));

// Discriminator vertex: on the driven edge AND at y = b, so it is free to
// contract under Poisson: the (L, b) corner.
const corner = nodesWhere(
  vertices,
  (x, y) => x >= length - 1e-9 && y >= width - 1e-9,
)[0];
// Midspan vertex on the symmetry line y = 0, where the linear field gives δ/2.
const mid = nodesWhere(
  vertices,
  (x, y) => Math.abs(x - length / 2) <= 1e-9 && y <= 1e-9,
)[0];

describe("shell membrane strip driven by a prescribed displacement", () => {
  let result = null;
  beforeAll(async () => {
    const solveShell = await loadShellSolver();
    result = solveShell(
      { vertices, triangles },
      { young_modulus: youngModulus, poisson_ratio: nu, thickness },
      { fixed_vertices: [], fixed_dofs, prescribed_dofs, point_loads: [] },
    );
  });

  const displacement = (vertex, component) =>
    result.displacements[vertex * 3 + component];

  test("shell solve produced finite displacements", () => {
    expect(result.displacements.every(Number.isFinite)).toBe(true);
  });

  // THE DISCRIMINATOR: the prescribed value actually reaches the driven edge.
  // A binary without shell prescribed_dofs pins it to zero, so "within 1% of δ"
  // cleanly separates applied from discarded.
  test("prescribed Ux is applied on the driven edge (ux ≈ δ, NOT zero)", () => {
    const uxEnd =
      driven.reduce((sum, vertex) => sum + displacement(vertex, 0), 0) /
      driven.length; // ≈ δ
    expect(
      Math.abs((uxEnd - delta) / delta),
      `ux=${uxEnd.toExponential(3)} vs δ=${delta.toExponential(3)}`,
    ).toBeLessThan(0.01);
  });

  // The CST reproduces the linear extension field exactly, so midspan lands on
  // δ/2: proof the whole field is driven, not just the constrained edge.
  test("midspan follows the linear extension field (ux ≈ δ/2)", () => {
    const uxMid = displacement(mid, 0);
    expect(
      Math.abs((uxMid - delta / 2) / (delta / 2)),
      `ux=${uxMid.toExponential(3)} vs ${(delta / 2).toExponential(3)}`,
    ).toBeLessThan(0.01);
  });

  // The transverse contraction is a SOLVED unknown, so it proves the driven edge
  // is FREE in y rather than clamped: an implementation that folded the
  // prescribed BC into a full fix would return uy = 0 here.
  test("driven edge is FREE in Uy and contracts under Poisson (not over-pinned)", () => {
    const uyCorner = displacement(corner, 1);
    expect(
      Math.abs((uyCorner - expUySide) / expUySide),
      `uy=${uyCorner.toExponential(3)} vs ${expUySide.toExponential(3)}`,
    ).toBeLessThan(0.05);
  });
});

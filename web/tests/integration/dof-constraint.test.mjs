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
// Runs against the freshly built WASM in CI. On a binary built before the
// engine's `fixed_dofs` support it is EXPECTED to fail: fixed_dofs is ignored,
// the model is unconstrained, and the solve blows up. That failure is the
// signal to rebuild the engine (scripts/build-wasm.sh).

import { beforeAll, describe, expect, test } from "bun:test";
import { loadSolver } from "../../../examples/validation/lib/solver.mjs";
import {
  boxHexMesh,
  nodesWhere,
  distributeForce,
} from "../../../examples/validation/lib/mesh.mjs";

const YOUNG = 200e9;
const POISSON = 0.3;
const LENGTH = 4;
const WIDTH = 1;
const HEIGHT = 1;
const SIGMA = 2e8; // applied tension (Pa)
const FORCE = SIGMA * WIDTH * HEIGHT;
const epsX = SIGMA / YOUNG;
const expUy = -POISSON * epsX * WIDTH; // Poisson contraction at y = W
const expUz = -POISSON * epsX * HEIGHT; // Poisson contraction at z = H

const mesh = boxHexMesh(LENGTH, WIDTH, HEIGHT, 4, 2, 2);

// Symmetry-plane rollers, all single-DOF. Union the components per node so the
// shared edges/corners carry several (e.g. the origin gets Ux+Uy+Uz).
const dofsByNode = new Map();
const addDof = (ids, dof) =>
  ids.forEach((id) => {
    if (!dofsByNode.has(id)) dofsByNode.set(id, new Set());
    dofsByNode.get(id).add(dof);
  });
addDof(
  nodesWhere(mesh.vertices, (px) => px <= 1e-9),
  0,
); // x=0 → Ux
addDof(
  nodesWhere(mesh.vertices, (px, py) => py <= 1e-9),
  1,
); // y=0 → Uy
addDof(
  nodesWhere(mesh.vertices, (px, py, pz) => pz <= 1e-9),
  2,
); // z=0 → Uz
const fixedDofs = [...dofsByNode].map(([vertex, components]) => ({
  vertex,
  dofs: [...components].sort(),
}));

const loaded = nodesWhere(mesh.vertices, (px) => px >= LENGTH - 1e-9);
const pointLoads = distributeForce(loaded, [FORCE, 0, 0]);

// The (0, W, H) corner — on the x=0 plane only ⇒ Ux-only.
const discriminator = nodesWhere(
  mesh.vertices,
  (px, py, pz) => px <= 1e-9 && py >= WIDTH - 1e-9 && pz >= HEIGHT - 1e-9,
)[0];

describe("single-DOF constraints (engine fixed_dofs)", () => {
  let displacements;
  let uxFace;
  const disp = (vertex, component) => displacements[vertex * 3 + component];

  beforeAll(async () => {
    const solve = await loadSolver();
    const result = solve(
      { vertices: mesh.vertices, hexahedra: mesh.hexahedra },
      { young_modulus: YOUNG, poisson_ratio: POISSON, density: 7850 },
      { fixed_vertices: [], fixed_dofs: fixedDofs, point_loads: pointLoads },
      1,
    );
    displacements = result.displacements;
    uxFace =
      loaded.reduce((sum, vertex) => sum + disp(vertex, 0), 0) / loaded.length; // ≈ εx·L
  });

  test("solve produced finite displacements", () => {
    expect(displacements.every(Number.isFinite)).toBe(true);
  });

  test("discriminator node is constrained in Ux (ux ≈ 0)", () => {
    expect(
      Math.abs(disp(discriminator, 0)),
      `ux=${disp(discriminator, 0).toExponential(3)}`,
    ).toBeLessThan(1e-3 * Math.abs(uxFace));
  });

  // THE DISCRIMINATOR: it is FREE in y and z and contracts under Poisson. A
  // full-fixity bug leaves these at zero, so "more than half the expected
  // contraction, with the right sign" cleanly separates fixed from free.
  test("discriminator node is FREE in Uy (Poisson contraction, not pinned)", () => {
    expect(
      disp(discriminator, 1),
      `uy=${disp(discriminator, 1).toExponential(3)} (expected ≈ ${expUy.toExponential(3)})`,
    ).toBeLessThan(0.5 * expUy);
  });

  test("discriminator node is FREE in Uz (Poisson contraction, not pinned)", () => {
    expect(
      disp(discriminator, 2),
      `uz=${disp(discriminator, 2).toExponential(3)} (expected ≈ ${expUz.toExponential(3)})`,
    ).toBeLessThan(0.5 * expUz);
  });

  // Physics sanity: the linear field matches theory.
  test("uniaxial extension ux ≈ εx·L (±5%)", () => {
    expect(
      Math.abs((uxFace - epsX * LENGTH) / (epsX * LENGTH)),
      `ux=${uxFace.toExponential(3)} vs ${(epsX * LENGTH).toExponential(3)}`,
    ).toBeLessThan(0.05);
  });

  test("Poisson contraction uy ≈ −ν·εx·W (±15%)", () => {
    expect(
      Math.abs((disp(discriminator, 1) - expUy) / expUy),
      `uy=${disp(discriminator, 1).toExponential(3)} vs ${expUy.toExponential(3)}`,
    ).toBeLessThan(0.15);
  });
});

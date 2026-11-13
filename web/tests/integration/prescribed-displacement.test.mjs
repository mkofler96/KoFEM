// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Idiot-proof regression test for non-zero prescribed displacements (issue #216).
//
// THE BUG THIS GUARDS: the UI lets you prescribe a non-zero displacement on a
// face (e.g. Ux = δ), but the solver used to fold every translational Dirichlet
// condition into fixed_vertices/fixed_dofs — which always pin to ZERO. The
// requested value was silently discarded, so a model driven purely by a
// prescribed displacement either did nothing or refused to run.
//
// Setup: uniaxial extension of a box [0,L]×[0,W]×[0,H] driven by displacement
// only, no applied load. Symmetry-plane rollers Ux=0 on x=0, Uy=0 on y=0,
// Uz=0 on z=0, and a NON-ZERO prescribed Ux=δ on the x=L face. The exact
// solution is the linear field
//   ux = εx·x,  uy = −ν·εx·y,  uz = −ν·εx·z,   εx = δ/L,
// independent of E (a pure-displacement boundary-value problem). Trilinear hexes
// reproduce it exactly. The x=L face must reach ux ≈ δ; the buggy binary pins it
// to zero.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadSolver } from "../../../examples/validation/lib/solver.mjs";
import {
  boxHexMesh,
  nodesWhere,
} from "../../../examples/validation/lib/mesh.mjs";

const nu = 0.3;
const youngModulus = 200e9; // result is E-independent; any positive value works
const length = 4,
  width = 1,
  height = 1;
const delta = 0.01; // prescribed Ux on the x=L face
const epsX = delta / length;
const expUy = -nu * epsX * width; // Poisson contraction at y = width
const expUz = -nu * epsX * height; // Poisson contraction at z = height

const mesh = boxHexMesh(length, width, height, 4, 2, 2);

// Symmetry-plane rollers (zero Dirichlet), unioned per node so shared edges
// carry several components (the origin gets Ux+Uy+Uz).
const zeroByNode = new Map();
const addZero = (ids, dof) =>
  ids.forEach((i) => {
    if (!zeroByNode.has(i)) zeroByNode.set(i, new Set());
    zeroByNode.get(i).add(dof);
  });
addZero(
  nodesWhere(mesh.vertices, (x) => x <= 1e-9),
  0,
); // x=0 → Ux=0
addZero(
  nodesWhere(mesh.vertices, (x, y) => y <= 1e-9),
  1,
); // y=0 → Uy=0
addZero(
  nodesWhere(mesh.vertices, (x, y, z) => z <= 1e-9),
  2,
); // z=0 → Uz=0
const fixed_dofs = [...zeroByNode].map(([vertex, s]) => ({
  vertex,
  dofs: [...s].sort(),
}));

// The driving condition: NON-ZERO prescribed Ux on the x=L face, no load.
const loaded = nodesWhere(mesh.vertices, (x) => x >= length - 1e-9);
const prescribed_dofs = loaded.map((vertex) => ({
  vertex,
  dof: 0,
  value: delta,
}));

// Discriminator node: free in y/z to show Poisson contraction. Pick the
// (L, W, H) corner, which sits on the x=L face only among the loaded set.
const disc = nodesWhere(
  mesh.vertices,
  (x, y, z) => x >= length - 1e-9 && y >= width - 1e-9 && z >= height - 1e-9,
)[0];

describe("uniaxial extension driven by a prescribed displacement", () => {
  let result = null;
  beforeAll(async () => {
    const solve = await loadSolver();
    result = solve(
      { vertices: mesh.vertices, hexahedra: mesh.hexahedra },
      { young_modulus: youngModulus, poisson_ratio: nu, density: 7850 },
      { fixed_vertices: [], fixed_dofs, prescribed_dofs, point_loads: [] },
      1,
    );
  });

  const displacement = (vertex, component) =>
    result.displacements[vertex * 3 + component];
  const uxFace = () =>
    loaded.reduce((sum, vertex) => sum + displacement(vertex, 0), 0) /
    loaded.length; // ≈ δ

  test("solve produced finite displacements", () => {
    expect(result.displacements.every(Number.isFinite)).toBe(true);
  });

  // THE DISCRIMINATOR: the prescribed value actually reaches the loaded face.
  // The buggy binary pins it to zero, so "within 5% of δ" cleanly separates
  // applied from discarded.
  test("prescribed Ux is applied on the loaded face (ux ≈ δ, NOT zero)", () => {
    expect(
      Math.abs((uxFace() - delta) / delta),
      `ux=${uxFace().toExponential(3)} vs δ=${delta.toExponential(3)}`,
    ).toBeLessThan(0.05);
  });

  // Physics sanity: the linear extension field matches theory. ux is fixed by
  // the prescribed BC, so it converges tightly regardless of solver tolerance.
  test("uniaxial extension ux ≈ εx·length (±5%)", () => {
    expect(
      Math.abs((uxFace() - epsX * length) / (epsX * length)),
      `ux=${uxFace().toExponential(3)} vs ${(epsX * length).toExponential(3)}`,
    ).toBeLessThan(0.05);
  });

  // The transverse contraction is a SOLVED unknown (unlike ux, which the BC
  // pins), so the engine's loose showcase CG tolerance (SetRelTol 1e-1) leaves
  // it under-converged and noisy: the magnitude overshoots and uy ≠ uz despite
  // W = H. We therefore assert direction, not tight magnitude: the prescribed
  // face must be FREE in y/z and contract under Poisson (more than half the
  // theoretical amount, correct sign), proving it is not over-pinned. This is
  // the same robust discriminator dof-constraint.test.mjs uses. Tight Poisson
  // accuracy under load is already covered by the main validation suite.
  test("loaded face is FREE in Uy and contracts under Poisson (not over-pinned)", () => {
    expect(
      displacement(disc, 1),
      `uy=${displacement(disc, 1).toExponential(3)} (expected ≈ ${expUy.toExponential(3)})`,
    ).toBeLessThan(0.5 * expUy);
  });

  test("loaded face is FREE in Uz and contracts under Poisson (not over-pinned)", () => {
    expect(
      displacement(disc, 2),
      `uz=${displacement(disc, 2).toExponential(3)} (expected ≈ ${expUz.toExponential(3)})`,
    ).toBeLessThan(0.5 * expUz);
  });
});

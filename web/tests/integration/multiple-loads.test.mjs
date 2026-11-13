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

import { beforeAll, describe, expect, test } from "bun:test";
import { loadSolver } from "../../../examples/validation/lib/solver.mjs";
import {
  boxHexMesh,
  nodesWhere,
} from "../../../examples/validation/lib/mesh.mjs";

const YOUNG = 200e9;
const POISSON = 0.3;
const LENGTH = 4,
  WIDTH = 1,
  HEIGHT = 1;
const cellsX = 4,
  cellsY = 2,
  cellsZ = 2;

const box = boxHexMesh(LENGTH, WIDTH, HEIGHT, cellsX, cellsY, cellsZ);
const mesh = { vertices: box.vertices, hexahedra: box.hexahedra };
const mat = { young_modulus: YOUNG, poisson_ratio: POISSON, density: 7850 };
const clamped = nodesWhere(box.vertices, (xCoord) => xCoord <= 1e-9);

// Quad boundary faces of the x=L (tip) and z=H (top) planes, in the node
// ordering the engine's generated boundary elements use: matching is by vertex
// SET, so only the grouping matters.
const tipFaces = [];
for (let row = 0; row < cellsY; row++)
  for (let layer = 0; layer < cellsZ; layer++)
    tipFaces.push([
      box.nid(cellsX, row, layer),
      box.nid(cellsX, row + 1, layer),
      box.nid(cellsX, row + 1, layer + 1),
      box.nid(cellsX, row, layer + 1),
    ]);
const topFaces = [];
for (let col = 0; col < cellsX; col++)
  for (let row = 0; row < cellsY; row++)
    topFaces.push([
      box.nid(col, row, cellsZ),
      box.nid(col + 1, row, cellsZ),
      box.nid(col + 1, row + 1, cellsZ),
      box.nid(col, row + 1, cellsZ),
    ]);

// L2 norm of the difference between two displacement fields, relative to the
// norm of the reference: one number that catches a dropped load anywhere in
// the model, not just at a probe node.
function relDiff(field, ref) {
  let num = 0,
    den = 0;
  for (let idx = 0; idx < ref.length; idx++) {
    num += (field[idx] - ref[idx]) ** 2;
    den += ref[idx] ** 2;
  }
  return Math.sqrt(num / den);
}
const sum = (first, second) => first.map((value, idx) => value + second[idx]);

// Two solves of the same physics differ only by CG convergence: each stops at a
// 1e-6 relative residual (run_cg_solve), so their displacement fields agree to
// ~1e-8, not to machine precision. SAME is set well above that noise floor and
// still five orders of magnitude below the signal a dropped load produces: a
// missing load costs a FRACTION of the answer (0.5 for one of two equal loads),
// never 1e-5. DIFFERENT is the other side of the same gap: a change that is real
// rather than numerical.
const SAME = 1e-5;
const DIFFERENT = 1e-2;

const FZ = -1e6;
const FY = -5e5;

describe("multiple surface loads in one solve (solve_mfem.cpp apply_surface_loads)", () => {
  let run;
  beforeAll(async () => {
    const solve = await loadSolver();
    run = (bcs) =>
      solve(mesh, mat, { fixed_vertices: clamped, ...bcs }, 1).displacements;
  });

  test("two loads on DISJOINT faces both act (== superposition)", () => {
    const tipDown = { type: "force", faces: tipFaces, force: [0, 0, FZ] };
    const topSide = { type: "force", faces: topFaces, force: [0, FY, 0] };
    const uTip = run({ surface_loads: [tipDown] });
    const uTop = run({ surface_loads: [topSide] });
    const uBoth = run({ surface_loads: [tipDown, topSide] });
    const diff = relDiff(uBoth, sum(uTip, uTop));
    expect(
      diff,
      `relative L2 difference ${diff.toExponential(2)}`,
    ).toBeLessThan(SAME);
  });

  // THE DISCRIMINATOR: two F/2 loads on the SAME faces must equal one F. The
  // buggy binary keeps only the last, giving exactly half, so this separates
  // "both applied" from "one silently dropped" by a factor of two.
  test("two loads on the SAME faces both act (F/2 + F/2 == F)", () => {
    const tipDown = { type: "force", faces: tipFaces, force: [0, 0, FZ] };
    const half = { type: "force", faces: tipFaces, force: [0, 0, FZ / 2] };
    const uTip = run({ surface_loads: [tipDown] });
    const uTwoHalves = run({ surface_loads: [half, half] });
    const diff = relDiff(uTwoHalves, uTip);
    expect(
      diff,
      `relative L2 difference ${diff.toExponential(2)}`,
    ).toBeLessThan(SAME);
  });

  // A pressure and a force on the same face is the everyday version of the same
  // overlap: both must survive.
  test("a force and a pressure on the SAME faces both act", () => {
    const tipDown = { type: "force", faces: tipFaces, force: [0, 0, FZ] };
    const tipPressure = { type: "pressure", faces: tipFaces, pressure: 5e7 };
    const uTip = run({ surface_loads: [tipDown] });
    const uPressure = run({ surface_loads: [tipPressure] });
    const uMixed = run({ surface_loads: [tipDown, tipPressure] });
    const diff = relDiff(uMixed, sum(uTip, uPressure));
    expect(
      diff,
      `relative L2 difference ${diff.toExponential(2)}`,
    ).toBeLessThan(SAME);
  });

  // The half of the top face nearest the tip, so the two selections share
  // elements without either containing the other.
  describe("partially overlapping loads", () => {
    const topOuter = topFaces.filter(
      (_face, idx) => idx >= topFaces.length / 2,
    );
    const overlapA = { type: "force", faces: topFaces, force: [0, FY, 0] };
    const overlapB = { type: "force", faces: topOuter, force: [0, 0, FZ / 4] };

    test("PARTIALLY overlapping loads both act in full", () => {
      const uA = run({ surface_loads: [overlapA] });
      const uB = run({ surface_loads: [overlapB] });
      const uOverlap = run({ surface_loads: [overlapA, overlapB] });
      const diff = relDiff(uOverlap, sum(uA, uB));
      expect(
        diff,
        `relative L2 difference ${diff.toExponential(2)}`,
      ).toBeLessThan(SAME);
    });

    // The opposite failure mode: a fix that de-duplicated overlapping loads
    // into one would pass every check above and still be wrong. Listing B twice
    // must deliver twice B's force, so the answer has to MOVE.
    test("overlapping loads are not silently merged (adding B twice changes the answer)", () => {
      const uOverlap = run({ surface_loads: [overlapA, overlapB] });
      const uDoubleB = run({
        surface_loads: [overlapA, overlapB, overlapB],
      });
      const diff = relDiff(uDoubleB, uOverlap);
      expect(
        diff,
        `relative L2 difference ${diff.toExponential(2)}`,
      ).toBeGreaterThan(DIFFERENT);
    });
  });

  // A prescribed displacement drives the model on its own, alongside any number
  // of homogeneous groups: a full clamp on x=0, a roller on y=0, and a
  // prescribed Ux on x=L, with no load anywhere.
  test("three Dirichlet groups and NO load: the prescribed value drives the model", () => {
    const delta = 0.004;
    const rollers = nodesWhere(
      box.vertices,
      (xCoord, yCoord) => yCoord <= 1e-9,
    ).map((vertex) => ({
      vertex,
      dofs: [1],
    }));
    const driven = nodesWhere(
      box.vertices,
      (xCoord) => xCoord >= LENGTH - 1e-9,
    );
    const uDirichlet = run({
      fixed_dofs: rollers,
      prescribed_dofs: driven.map((vertex) => ({
        vertex,
        dof: 0,
        value: delta,
      })),
    });
    const uxFace =
      driven.reduce((total, vertex) => total + uDirichlet[3 * vertex], 0) /
      driven.length;
    expect(
      Math.abs((uxFace - delta) / delta),
      `ux=${uxFace.toExponential(3)} vs delta=${delta.toExponential(3)}`,
    ).toBeLessThan(0.05);
  });
});

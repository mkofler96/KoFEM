// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Rust module solves on the stiffness matrix it assembled, not a copy
// (KOF-457). A solve takes the model's matrix for as long as it runs and
// gives it back exactly when it finishes or is freed, so support reactions and
// further load cases see the assembled matrix, and the module never holds two.
//
// The first test measures the module's memory, so it must run before any
// other solve in this file has left freed memory behind for a copy to reuse.

import { beforeAll, describe, expect, test } from "bun:test";
import { boxHexMesh } from "../../../examples/validation/lib/mesh.mjs";
import {
  ElasticModel,
  ShellModel,
  SolveOptions,
} from "../../src/wasm/fem/kofem_wasm.js";
import { loadFem } from "../support/wasm.mjs";

const LENGTH = 240;
const SIDE = 24;
const YOUNG = 210000;
const POISSON = 0.3;
const TIP = -1000;

// A beam of 60 × 6 × 6 linear hexes, clamped at x = 0, tip load in z.
const box = boxHexMesh(LENGTH, SIDE, SIDE, 60, 6, 6);
const vertices = new Float64Array(box.vertices.flat());
const hexes = new Uint32Array(box.hexahedra.flat());
const clamped = box.vertices.flatMap((point, node) =>
  point[0] === 0 ? [node] : [],
);
const tip = box.vertices.flatMap((point, node) =>
  point[0] === LENGTH ? [node] : [],
);
const fixedDofs = new Uint32Array(
  clamped.flatMap((node) => [3 * node, 3 * node + 1, 3 * node + 2]),
);
const fixedValues = new Float64Array(fixedDofs.length);
// One support (index 0) owning the clamp's three translations; rotations free.
const owners = new Int32Array(6 * box.vertices.length).fill(-1);
for (const node of clamped)
  for (let c = 0; c < 3; c++) owners[6 * node + c] = 0;

function beam() {
  const model = new ElasticModel(
    vertices,
    new Uint32Array(0),
    hexes,
    new Uint32Array(box.hexahedra.length),
    new Float64Array([YOUNG, POISSON]),
    1,
  );
  const nonzeros = model.assemble();
  const forces = new Float64Array(model.dofCount);
  for (const node of tip) forces[3 * node + 2] = TIP / tip.length;
  return { model, nonzeros, forces };
}

function solve(model, forces, preconditioner) {
  const options = new SolveOptions(1e-10, 20000, preconditioner, "residual");
  const run = model.startSolve(fixedDofs, fixedValues, forces, options);
  options.free();
  while (!run.advance(200));
  return run.finish();
}

// Σ of the clamp's reaction in z: support 0's force, then its moment.
function clampForceZ(model, solution, forces) {
  return model.supportReactions(solution, forces, owners, 1)[2];
}

let memory;

beforeAll(async () => {
  const fem = await loadFem();
  // Initialised already: this returns the module's exports, memory included.
  memory = (await fem.default()).memory;
});

describe("a solid solve on the assembled matrix", () => {
  test("starting a solve does not grow the module by a copy of the matrix", () => {
    const { model, nonzeros, forces } = beam();
    const before = memory.buffer.byteLength;
    const options = new SolveOptions(1e-10, 20000, "gauss-seidel", "residual");
    const run = model.startSolve(fixedDofs, fixedValues, forces, options);
    const grown = memory.buffer.byteLength - before;
    // A copy would add 12 bytes per entry (an f64 value and a u32 column).
    expect(
      grown,
      `startSolve grew the module by ${grown} bytes for ${nonzeros} entries`,
    ).toBeLessThan(6 * nonzeros);
    run.free();
    options.free();
    model.free();
  });

  test("the model has no matrix while a solve holds it", () => {
    const { model, forces } = beam();
    const options = new SolveOptions(1e-10, 20000, "amg", "residual");
    const run = model.startSolve(fixedDofs, fixedValues, forces, options);
    expect(() =>
      model.startSolve(fixedDofs, fixedValues, forces, options),
    ).toThrow(/a solve is running on this model's stiffness matrix/);
    run.free();
    options.free();
    model.free();
  });

  test("a finished solve gives the matrix back for reactions and the next load case", () => {
    const { model, forces } = beam();
    const first = solve(model, forces, "gauss-seidel");
    expect(clampForceZ(model, first, forces)).toBeCloseTo(-TIP, 6);
    const second = solve(model, forces, "amg");
    expect(clampForceZ(model, second, forces)).toBeCloseTo(-TIP, 6);
    const tipNode = tip[0];
    expect(second.displacements[3 * tipNode + 2]).toBeCloseTo(
      first.displacements[3 * tipNode + 2],
      8,
    );
    first.free();
    second.free();
    model.free();
  });

  test("a solve freed before it finishes gives the matrix back too", () => {
    const { model, forces } = beam();
    const options = new SolveOptions(1e-10, 20000, "gauss-seidel", "residual");
    model.startSolve(fixedDofs, fixedValues, forces, options).free();
    options.free();
    const solution = solve(model, forces, "amg");
    expect(clampForceZ(model, solution, forces)).toBeCloseTo(-TIP, 6);
    solution.free();
    model.free();
  });
});

describe("a shell solve on the assembled matrix", () => {
  // A 30 × 4 plate of triangles, 1 mm thick, clamped along x = 0.
  const nx = 30;
  const ny = 4;
  const id = (i, j) => i * (ny + 1) + j;
  const plateVertices = [];
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= ny; j++) plateVertices.push(10 * i, 10 * j, 0);
  const triangles = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      triangles.push(
        id(i, j),
        id(i + 1, j),
        id(i + 1, j + 1),
        id(i, j),
        id(i + 1, j + 1),
        id(i, j + 1),
      );
  const count = triangles.length / 3;
  const held = Array.from({ length: ny + 1 }, (_, j) => id(0, j));
  const shellFixed = new Uint32Array(
    held.flatMap((v) => [0, 1, 2, 3, 4, 5].map((c) => 6 * v + c)),
  );
  const shellOwners = new Int32Array((6 * plateVertices.length) / 3).fill(-1);
  for (const v of held) for (let c = 0; c < 6; c++) shellOwners[6 * v + c] = 0;

  function plate() {
    const model = new ShellModel(
      new Float64Array(plateVertices),
      new Uint32Array(triangles),
      new Float64Array(count).fill(1),
      new Uint32Array(count),
      new Float64Array([YOUNG, POISSON]),
    );
    model.assemble();
    const forces = new Float64Array(model.dofCount);
    for (let j = 0; j <= ny; j++) forces[6 * id(nx, j) + 2] = TIP / (ny + 1);
    return { model, forces };
  }

  function solveShell(model, forces) {
    const run = model.startSolve(
      shellFixed,
      new Float64Array(shellFixed.length),
      forces,
      1e-10,
    );
    while (!run.advance(200));
    return run.finish();
  }

  test("the model has no matrix while a solve holds it", () => {
    const { model, forces } = plate();
    const run = model.startSolve(
      shellFixed,
      new Float64Array(shellFixed.length),
      forces,
      1e-10,
    );
    expect(() =>
      model.startSolve(
        shellFixed,
        new Float64Array(shellFixed.length),
        forces,
        1e-10,
      ),
    ).toThrow(/a solve is running on this model's stiffness matrix/);
    run.free();
    model.free();
  });

  test("a finished solve gives the matrix back for reactions and the next load case", () => {
    const { model, forces } = plate();
    for (let round = 0; round < 2; round++) {
      const solution = solveShell(model, forces);
      const reaction = model.supportReactions(solution, forces, shellOwners, 1);
      expect(reaction[2]).toBeCloseTo(-TIP, 6);
      solution.free();
    }
    model.free();
  });
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-490: each numerical sub-reason of a failed solve, from a model the Rust
// module really fails on, through the app's solve paths (lib/solve) and the
// classification the solve_failed event and the Solve panel use. The error
// reaches the page as the worker sends it: a WorkerTaskError of the solving
// step, carrying the "Error: message" text.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  createRustSolidModel,
  rustSolidBoundaryConditions,
  solveSolidInRust,
} from "../../src/lib/solve/amg.ts";
import { createShellModel } from "../../src/lib/solve/shellRust.ts";
import {
  modelRigidBodyInput,
  unheldBodiesMessage,
} from "../../src/lib/solve/rigidBody.ts";
import { buildVertexIndexer } from "../../src/lib/solveMeshPacking.ts";
import { classifyFailure } from "../../src/lib/analytics.ts";
import { WorkerTaskError } from "../../src/lib/workerError.ts";
import { boxHexMesh } from "../../../examples/validation/lib/mesh.mjs";
import { loadFem } from "../support/wasm.mjs";

let fem = null;
beforeAll(async () => {
  fem = await loadFem();
});

const MATERIALS = [
  { id: 1, name: "Soft", young: 1000, poisson: 0.3, density: 1 },
];
const silent = () => undefined;
const stop = async () => 0;

// A bar `length` long along x, `depth` square, clamped at x = 0.
function clampedBar({ length = 10, depth = 0.4, cells = 20 } = {}) {
  const mesh = boxHexMesh(length, depth, depth, cells, 1, 1);
  const nodes = mesh.vertices.map((v, i) => ({
    id: i + 1,
    x: v[0],
    y: v[1],
    z: v[2],
  }));
  const elements = mesh.hexahedra.map((hex, index) => ({
    id: index + 1,
    type: "CHEXA",
    nodeIds: hex.map((n) => n + 1),
    propertyId: 1,
  }));
  const constraints = nodes
    .filter((node) => node.x === 0)
    .flatMap((node) => [0, 1, 2].map((dof) => ({ nodeId: node.id, dof })));
  const end = nodes.filter((node) => node.x === length);
  return {
    nodes,
    elements,
    materials: MATERIALS,
    properties: [{ id: 1, materialId: 1 }],
    constraints,
    // `force` in total on the free end, along `dof`.
    endLoad: (dof, force) =>
      end.map((node) => ({ nodeId: node.id, dof, value: force / end.length })),
  };
}

// How the page sees a solve's rejection: the worker's "name: message" text in
// the solving step.
function asWorkerSends(err) {
  const text = `${err.name}: ${err.message}`;
  return new WorkerTaskError(text, "solving", text);
}

async function failedSolve(model, { method = "amg", iterationLimit } = {}) {
  const vid = buildVertexIndexer(model.nodes);
  try {
    await solveSolidInRust(
      fem,
      model,
      1,
      method,
      vid,
      vid,
      iterationLimit,
      stop,
      silent,
    );
  } catch (err) {
    return asWorkerSends(err);
  }
  throw new Error("the solve was expected to fail, but it returned a result");
}

const numerical = (reason) => ({
  error_category: "numerical_failure",
  numerical_reason: reason,
});

describe("singular_matrix", () => {
  // Two blocks of one body that share only an edge: the rigid-body check
  // holds the body, but the second block swings about the edge.
  function hingedBlocks() {
    const nodes = [];
    const index = new Map();
    const node = (x, y, z) => {
      const key = `${x},${y},${z}`;
      if (!index.has(key)) {
        index.set(key, nodes.length + 1);
        nodes.push({ id: nodes.length + 1, x, y, z });
      }
      return index.get(key);
    };
    const hex = (x, y) =>
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
      ].map(([dx, dy, dz]) => node(x + dx, y + dy, dz));
    const elements = [hex(0, 0), hex(1, 0), hex(2, 1)].map((nodeIds, i) => ({
      id: i + 1,
      type: "CHEXA",
      nodeIds,
      propertyId: 1,
    }));
    const constraints = nodes
      .filter((n) => n.x === 0)
      .flatMap((n) => [0, 1, 2].map((dof) => ({ nodeId: n.id, dof })));
    const loads = nodes
      .filter((n) => n.x === 3)
      .map((n) => ({ nodeId: n.id, dof: 1, value: -1 }));
    return {
      nodes,
      elements,
      materials: MATERIALS,
      properties: [{ id: 1, materialId: 1 }],
      constraints,
      loads,
    };
  }

  test("a block hinged on one edge passes the rigid-body check and fails AMG's coarsest level", async () => {
    const model = hingedBlocks();
    expect(
      unheldBodiesMessage(fem, modelRigidBodyInput(model), model.properties),
    ).toBeNull();
    const err = await failedSolve(model);
    expect(err.english).toContain("coarsest multigrid matrix");
    expect(classifyFailure(err)).toEqual(numerical("singular_matrix"));
  });

  test("an unsupported bar breaks CG down under Gauss–Seidel", async () => {
    const bar = clampedBar();
    const err = await failedSolve(
      { ...bar, constraints: [], loads: bar.endLoad(1, 1) },
      { method: "gauss-seidel" },
    );
    expect(err.english).toContain("CG breakdown");
    expect(classifyFailure(err)).toEqual(numerical("singular_matrix"));
  });
});

test("not_converged: CG stalls at its iteration limit", async () => {
  const bar = clampedBar();
  const err = await failedSolve(
    { ...bar, loads: bar.endLoad(1, -0.01) },
    { method: "gauss-seidel", iterationLimit: 1 },
  );
  expect(err.english).toContain("CG did not converge");
  expect(classifyFailure(err)).toEqual(numerical("not_converged"));
});

test("newton_not_converged: an increment outruns its Newton iterations", () => {
  const bar = clampedBar();
  const model = { ...bar, loads: bar.endLoad(1, -1e-4) };
  const vid = buildVertexIndexer(model.nodes);
  const { elastic } = createRustSolidModel(fem, model, 1, vid);
  const { fixedDofs, fixedValues, forces } = rustSolidBoundaryConditions(
    elastic,
    model,
    vid,
  );
  const options = new fem.SolveOptions(1e-6, 1000, "amg", "residual");
  let failure = null;
  try {
    // One Newton iteration per increment cannot reach the target.
    const run = elastic.startLargeDeformationSolve(
      fixedDofs,
      fixedValues,
      forces,
      options,
      1,
      1,
    );
    while (!run.advance(50));
  } catch (err) {
    failure = asWorkerSends(err);
  } finally {
    options.free();
    elastic.free();
  }
  expect(failure?.english).toContain("did not converge");
  expect(classifyFailure(failure)).toEqual(numerical("newton_not_converged"));
});

describe("large deformation in one increment", () => {
  test("unstable_tangent: a bar pulled far past its limit", async () => {
    const bar = clampedBar();
    const err = await failedSolve({
      ...bar,
      loads: bar.endLoad(0, 1000),
      largeDeformation: { increments: 1 },
    });
    expect(err.english).toContain("buckles or snaps through");
    expect(classifyFailure(err)).toEqual(numerical("unstable_tangent"));
  });

  test("inverted_element: a bar bent far in one step", async () => {
    const bar = clampedBar();
    const err = await failedSolve({
      ...bar,
      loads: bar.endLoad(1, -100),
      largeDeformation: { increments: 1 },
    });
    expect(err.english).toContain("turned inside out");
    expect(classifyFailure(err)).toEqual(numerical("inverted_element"));
  });
});

test("non_finite_result: shell stresses from overflowing displacements", () => {
  const { model } = createShellModel(fem, {
    mesh: { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], triangles: [0, 1, 2] },
    matJson: JSON.stringify({
      young_modulus: 2e11,
      poisson_ratio: 0.3,
      thickness: 0.01,
    }),
    bcsJson: "{}",
  });
  const dofs = new Float64Array(model.dofCount);
  dofs[6] = 1e300;
  let failure = null;
  try {
    model.vonMises(dofs);
  } catch (err) {
    failure = asWorkerSends(err);
  } finally {
    model.free();
  }
  expect(failure?.english).toContain("not a finite number");
  expect(classifyFailure(failure)).toEqual(numerical("non_finite_result"));
});

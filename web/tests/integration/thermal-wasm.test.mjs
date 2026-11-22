// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Field expressions and thermal loads through the built Rust module: a
// temperature formula evaluated at the model's nodes, its equivalent nodal
// forces on one hexahedron, and the free thermal expansion they produce.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  ElasticModel,
  SolveOptions,
  checkFieldExpression,
  evaluateFieldExpression,
} from "../../src/wasm/fem/kofem_wasm.js";
import { loadFem } from "../support/wasm.mjs";

const YOUNG = 210000;
const POISSON = 0.3;
const ALPHA = 1.2e-5;
const SIDE = 10;

// One cube hexahedron, MFEM / CHEXA corner order.
const vertices = new Float64Array(
  [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ].flatMap((corner) => corner.map((value) => SIDE * value)),
);
const hexes = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]);

function cube(order) {
  return new ElasticModel(
    vertices,
    new Uint32Array(),
    hexes,
    new Uint32Array([0]),
    new Float64Array([YOUNG, POISSON]),
    order,
  );
}

beforeAll(async () => {
  await loadFem();
});

describe("field expressions", () => {
  test("evaluate at x, y, z triples", () => {
    const values = evaluateFieldExpression(
      "sqrt(x^2 + y^2) + z",
      new Float64Array([3, 4, 1, 0, 0, -2]),
    );
    expect(Array.from(values)).toEqual([6, -2]);
  });

  test("errors name the problem and its position", () => {
    expect(() => checkFieldExpression("x + foo")).toThrow(/foo.*position 5/);
    expect(() => checkFieldExpression("(x + 1")).toThrow(/position 1/);
    expect(() => checkFieldExpression("x + y")).not.toThrow();
    expect(() =>
      evaluateFieldExpression("1 / x", new Float64Array([0, 1, 2])),
    ).toThrow(/\(0, 1, 2\)/);
  });
});

describe("thermal load", () => {
  for (const order of [1, 2]) {
    test(`uniform ΔT expands a free order-${order} hexahedron`, () => {
      const model = cube(order);
      const nodes = model.nodeCoordinates;
      expect(nodes.length).toBe(model.dofCount);
      const deltaT = 50;
      const temperatures = evaluateFieldExpression(`${deltaT}`, nodes);
      const alpha = new Float64Array([ALPHA]);
      const forces = model.thermalLoad(alpha, temperatures);
      // The forces on the face x = SIDE sum to the restrained stress over
      // its area, E·α·ΔT/(1 − 2ν)·A, pointing outward.
      let farFace = 0;
      for (let node = 0; node < nodes.length / 3; node++)
        if (Math.abs(nodes[3 * node] - SIDE) < 1e-9)
          farFace += forces[3 * node];
      const restrained = (YOUNG * ALPHA * deltaT) / (1 - 2 * POISSON);
      expect(farFace).toBeCloseTo(restrained * SIDE * SIDE, 6);

      // 3-2-1 supports: the origin fixed, vertex 1 in y and z, vertex 3 in z.
      model.assemble();
      const fixed = new Uint32Array([0, 1, 2, 4, 5, 11]);
      const options = new SolveOptions(
        1e-12,
        10000,
        "gauss-seidel",
        "residual",
      );
      const solution = model.solve(
        fixed,
        new Float64Array(fixed.length),
        forces,
        options,
      );
      const displacements = solution.displacements;
      const strain = ALPHA * deltaT;
      for (let dof = 0; dof < nodes.length; dof++)
        expect(displacements[dof]).toBeCloseTo(strain * nodes[dof], 10);
      const centre = model.thermalStrains(alpha, temperatures);
      expect(centre[0]).toBeCloseTo(strain, 14);
    });
  }

  test("refuses a ΔT per vertex on a quadratic model", () => {
    const model = cube(2);
    expect(() =>
      model.thermalLoad(new Float64Array([ALPHA]), new Float64Array(8)),
    ).toThrow(/8 temperature changes given for 27 nodes/);
  });
});

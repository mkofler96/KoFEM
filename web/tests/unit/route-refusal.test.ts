// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Solve panel shows routeSolve's refusal as a failing pre-flight row, in
// the words the worker would refuse the solve with (KOF-353, KOF-460).

import { expect, test } from "bun:test";
import type { SolveModel } from "../../src/workers/solverTypes";
import { routeOrRefusal } from "../../src/lib/solve/route";
import { shellOrderRefusal } from "../../src/lib/solve/refusals";

const shellModel: SolveModel = {
  nodes: [
    { id: 1, x: 0, y: 0, z: 0 },
    { id: 2, x: 1, y: 0, z: 0 },
    { id: 3, x: 0, y: 1, z: 0 },
  ],
  elements: [{ id: 1, type: "CTRIA3", nodeIds: [1, 2, 3], propertyId: 1 }],
  materials: [
    { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 7.85e-9 },
  ],
  properties: [{ id: 1, materialId: 1, discretization: "shell", thickness: 1 }],
  constraints: [],
  loads: [],
};

test("no model yet: neither a route nor a refusal", () => {
  expect(routeOrRefusal(null)).toEqual({ route: null, routeRefusal: null });
});

test("a routed model has its route and no refusal", () => {
  expect(routeOrRefusal(shellModel)).toEqual({
    route: { path: "shell" },
    routeRefusal: null,
  });
});

test("a refused model gives the refusal message verbatim", () => {
  expect(routeOrRefusal({ ...shellModel, elementOrder: 2 })).toEqual({
    route: null,
    routeRefusal: shellOrderRefusal(2),
  });
});

test("a throw that is not a refusal is not shown as one", () => {
  const broken = {
    ...shellModel,
    get elements(): SolveModel["elements"] {
      throw "not an Error";
    },
  };
  expect(() => routeOrRefusal(broken)).toThrow("not an Error");
});

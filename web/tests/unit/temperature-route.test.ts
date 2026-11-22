// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A temperature change (KOF-449) is applied by the solid solve only: a shell,
// coupled or auto-shell model, and a topology optimization, refuse it by name
// rather than solve without it.

import { expect, test } from "bun:test";
import type {
  Element,
  Node,
  SolveModel,
  TopOptPayload,
} from "../../src/workers/solverTypes";
import { routeSolve, routeTopOpt } from "../../src/lib/solve/route";

const nodes: Node[] = [
  { id: 1, x: 0, y: 0, z: 0 },
  { id: 2, x: 1, y: 0, z: 0 },
  { id: 3, x: 0, y: 1, z: 0 },
  { id: 4, x: 0, y: 0, z: 1 },
];
const tet: Element = {
  id: 1,
  type: "CTETRA",
  nodeIds: [1, 2, 3, 4],
  propertyId: 1,
};
const shellProperty = {
  id: 2,
  materialId: 1,
  discretization: "shell" as const,
  thickness: 1,
};
const withShells = (elements: Element[]): SolveModel => ({
  ...base,
  elements,
  properties: [...base.properties, shellProperty],
});
const tri: Element = {
  id: 2,
  type: "CTRIA3",
  nodeIds: [1, 2, 3],
  propertyId: 2,
};
const base: SolveModel = {
  nodes,
  elements: [tet],
  materials: [
    {
      id: 1,
      name: "Steel",
      young: 210000,
      poisson: 0.3,
      density: 7.85e-9,
      expansion: 1.2e-5,
    },
  ],
  properties: [{ id: 1, materialId: 1, discretization: "solid" }],
  constraints: [],
  loads: [],
  temperature: { formula: "10" },
};

test("a solid model takes a temperature change on the solid path", () => {
  expect(routeSolve(base)).toEqual({ path: "solid" });
});

test("a shell model refuses a temperature change", () => {
  expect(() => routeSolve(withShells([tri]))).toThrow(
    /temperature change.*solid/i,
  );
});

test("a mixed shell and solid model refuses a temperature change", () => {
  expect(() => routeSolve(withShells([tet, tri]))).toThrow(
    /temperature change.*solid/i,
  );
});

test("a model without a temperature change routes as before", () => {
  expect(routeSolve({ ...withShells([tri]), temperature: null })).toEqual({
    path: "shell",
  });
});

test("a topology optimization refuses a temperature change", () => {
  const payload = {
    ...base,
    settings: {},
  } as unknown as TopOptPayload;
  expect(() => routeTopOpt(payload)).toThrow(/temperature change/i);
});

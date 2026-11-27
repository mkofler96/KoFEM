// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Large deformation (KOF-486) is solved on the all-solid path: a shell,
// coupled or auto-shell model and a topology optimization refuse it by name,
// as does a solid model with what its solve does not carry yet (a contact, a
// constraint tie, a temperature change), rather than solve a linear model
// behind the user's back.

import { expect, test } from "bun:test";
import type {
  Element,
  Node,
  SolveModel,
  TopOptPayload,
} from "../../src/workers/solverTypes";
import type { TieDefinition, TieMethod } from "../../src/lib/tie";
import { routeSolve, routeTopOpt } from "../../src/lib/solve/route";
import { solvePayload, type SolveSource } from "../../src/lib/solve/payload";

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
  largeDeformation: { increments: 10 },
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

test("a solid model solves with large deformation on the solid path", () => {
  expect(routeSolve(base)).toEqual({ path: "solid" });
});

test("a quadratic solid model solves with large deformation too", () => {
  expect(routeSolve({ ...base, elementOrder: 2 })).toEqual({ path: "solid" });
});

test("a shell model refuses large deformation", () => {
  expect(() => routeSolve(withShells([tri]))).toThrow(
    /large deformation.*solid/i,
  );
});

test("a mixed shell and solid model refuses large deformation", () => {
  expect(() => routeSolve(withShells([tet, tri]))).toThrow(
    /large deformation.*solid/i,
  );
});

test("a body solved as a shell refuses large deformation", () => {
  expect(() =>
    routeSolve({
      ...base,
      properties: [{ id: 1, materialId: 1, discretization: "shell" }],
    }),
  ).toThrow(/large deformation.*solid/i);
});

test("a model with a coupling refuses large deformation", () => {
  expect(() =>
    routeSolve({
      ...base,
      couplings: [
        {
          name: "RP1",
          kind: "distributing",
          dofs: [0, 1, 2, 3, 4, 5],
          refNodeId: 1,
          faces: [{ nodeIds: [2, 3, 4] }],
        },
      ],
    }),
  ).toThrow(/large deformation.*solid/i);
});

test("a contact refuses large deformation", () => {
  expect(() =>
    routeSolve({
      ...base,
      contacts: [
        {
          name: "Contact1",
          facesA: [{ nodeIds: [1, 2, 3] }],
          facesB: [{ nodeIds: [1, 2, 4] }],
        },
      ],
    }),
  ).toThrow(/large deformation.*"Contact1"/i);
});

test("a constraint tie refuses large deformation, a merged tie does not", () => {
  const tie = (method: TieMethod): TieDefinition => ({
    name: "Tie1",
    method,
    facesA: [{ nodeIds: [1, 2, 3] }],
    facesB: [{ nodeIds: [1, 2, 4] }],
    extent: "full",
    searchDistance: 0.1,
  });
  expect(() =>
    routeSolve({
      ...base,
      tieGroups: [tie("mpc")],
    }),
  ).toThrow(/large deformation.*"Tie1"/i);
  expect(
    routeSolve({
      ...base,
      tieGroups: [tie("merge")],
    }),
  ).toEqual({ path: "solid" });
});

test("a temperature change refuses large deformation", () => {
  expect(() => routeSolve({ ...base, temperature: { formula: "10" } })).toThrow(
    /large deformation.*temperature/i,
  );
});

test("without large deformation a shell model routes as before", () => {
  expect(routeSolve({ ...withShells([tri]), largeDeformation: null })).toEqual({
    path: "shell",
  });
});

test("a topology optimization refuses large deformation", () => {
  const payload = {
    ...base,
    settings: {},
  } as unknown as TopOptPayload;
  expect(() => routeTopOpt(payload)).toThrow(/large deformation/i);
});

test("the solve request carries large deformation only when it is on", () => {
  const source = {
    ...base,
    surfaceLoads: [],
    temperature: null,
    elementOrder: 1,
    solverMethod: "amg",
    tieGroups: [],
    couplingGroups: [],
    contactGroups: [],
    surfaceTriangles: null,
    surfaceFaceIds: null,
    largeDeformation: true,
    loadIncrements: 12,
  } satisfies SolveSource;
  expect(solvePayload(source).largeDeformation).toEqual({ increments: 12 });
  expect(
    solvePayload({ ...source, largeDeformation: false }).largeDeformation,
  ).toBeNull();
});

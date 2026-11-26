// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Contact (KOF-485) is solved on the all-solid path with linear elements: a
// shell, coupled or auto-shell model, element order 2, and a topology
// optimization refuse a contact by name rather than solve without it.

import { expect, test } from "bun:test";
import type {
  Element,
  Node,
  SolveModel,
  TopOptPayload,
} from "../../src/workers/solverTypes";
import type { ContactDefinition } from "../../src/lib/contact";
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
const tri: Element = {
  id: 2,
  type: "CTRIA3",
  nodeIds: [1, 2, 3],
  propertyId: 2,
};
const contact: ContactDefinition = {
  name: "Contact1",
  facesA: [{ nodeIds: [1, 2, 3] }],
  facesB: [{ nodeIds: [1, 2, 4] }],
};
const base: SolveModel = {
  nodes,
  elements: [tet],
  materials: [
    { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 7.85e-9 },
  ],
  properties: [{ id: 1, materialId: 1, discretization: "solid" }],
  constraints: [],
  loads: [],
  contacts: [contact],
};
const shellProperty = {
  id: 2,
  materialId: 1,
  discretization: "shell" as const,
  thickness: 1,
};

test("a solid model with contact routes to the solid solve", () => {
  expect(routeSolve(base)).toEqual({ path: "solid" });
});

test("a mixed shell and solid model refuses a contact by name", () => {
  const model: SolveModel = {
    ...base,
    elements: [tet, tri],
    properties: [...base.properties, shellProperty],
  };
  expect(() => routeSolve(model)).toThrow(/contact "Contact1".*solid/i);
});

test("a model with a coupling refuses a contact", () => {
  const model: SolveModel = {
    ...base,
    couplings: [
      {
        name: "RP1",
        kind: "distributing",
        faces: [{ nodeIds: [1, 2, 3] }],
        refPoint: [0, 0, 0],
      },
    ] as unknown as SolveModel["couplings"],
  };
  expect(() => routeSolve(model)).toThrow(/contact "Contact1".*solid/i);
});

test("a body solved as a shell refuses a contact", () => {
  const model: SolveModel = {
    ...base,
    properties: [
      { id: 1, materialId: 1, discretization: "shell", thickness: 1 },
    ],
  };
  expect(() => routeSolve(model)).toThrow(/contact "Contact1".*solid/i);
});

test("quadratic elements refuse a contact", () => {
  expect(() => routeSolve({ ...base, elementOrder: 2 })).toThrow(
    /contact "Contact1".*linear/i,
  );
});

test("a topology optimization refuses a contact", () => {
  const payload = {
    ...base,
    settings: { method: "simp", constraints: {} },
  } as unknown as TopOptPayload;
  expect(() => routeTopOpt(payload)).toThrow(/contact "Contact1"/i);
});

test("a model without contact routes as before", () => {
  expect(routeSolve({ ...base, contacts: undefined, elementOrder: 2 })).toEqual(
    { path: "solid" },
  );
});

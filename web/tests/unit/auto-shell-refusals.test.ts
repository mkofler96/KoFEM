// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A body marked Shell is solved as shells or the solve fails with the body and
// the reason (KOF-352). These are the refusals decided before the shell
// idealisation runs, so no WebAssembly is needed; the refusal that needs the
// idealisation (a Shell body that touches no solid body) is in
// tests/integration/shell-rust.test.mjs.

import { expect, test } from "bun:test";
import type {
  Element,
  Node,
  SolvePayload,
} from "../../src/workers/solverTypes";
import {
  buildMeshTimeShellModel,
  prepareAutoShellSolve,
} from "../../src/lib/solve/autoShell";

// One tetrahedron (body 1, marked Shell) and one hexahedron (body 2, solid).
const nodes: Node[] = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [2, 0, 0],
  [3, 0, 0],
  [3, 1, 0],
  [2, 1, 0],
  [2, 0, 1],
  [3, 0, 1],
  [3, 1, 1],
  [2, 1, 1],
].map(([x, y, z], index) => ({ id: index + 1, x, y, z }));
const tet: Element = {
  id: 1,
  type: "CTETRA",
  nodeIds: [1, 2, 3, 4],
  propertyId: 1,
};
const hex: Element = {
  id: 2,
  type: "CHEXA",
  nodeIds: [5, 6, 7, 8, 9, 10, 11, 12],
  propertyId: 2,
};
const tetSurface: [number, number, number][] = [
  [1, 3, 2],
  [1, 2, 4],
  [1, 4, 3],
  [2, 3, 4],
];

function payload(overrides: Partial<SolvePayload>): SolvePayload {
  return {
    nodes,
    elements: [tet],
    materials: [
      { id: 1, name: "Steel", young: 210000, poisson: 0.3, density: 7.85e-9 },
    ],
    properties: [
      { id: 1, materialId: 1, discretization: "shell" },
      { id: 2, materialId: 1, discretization: "solid" },
    ],
    constraints: [],
    loads: [],
    surfaceTriangles: tetSurface,
    surfaceFaceIds: [1, 2, 3, 4],
    solverMethod: "amg",
    ...overrides,
  };
}

const quiet = () => {
  /* progress lines are not asserted on */
};

test("a Shell body in a model without a surface mesh is refused, naming the body", () => {
  for (const surface of [
    { surfaceTriangles: null, surfaceFaceIds: null },
    { surfaceTriangles: [], surfaceFaceIds: [] },
  ])
    expect(() =>
      prepareAutoShellSolve(payload(surface), new Set([1]), quiet),
    ).toThrow(/Body 1 is marked "Shell".*no surface mesh/);
});

test("a Shell body in a model with hexahedra is refused, naming the body", () => {
  expect(() =>
    prepareAutoShellSolve(
      payload({ elements: [tet, hex] }),
      new Set([1]),
      quiet,
    ),
  ).toThrow(/Body 1 is marked "Shell".*1 hexahedral element/);
});

test("surface arrays of different lengths are an error, not a model without shells", () => {
  const corrupt = { surfaceFaceIds: [1, 2, 3] };
  expect(() =>
    prepareAutoShellSolve(payload(corrupt), new Set([1]), quiet),
  ).toThrow(/4 surface triangles but 3 face ids/);
  expect(() =>
    buildMeshTimeShellModel(
      nodes,
      [tet],
      tetSurface,
      [1, 2, 3],
      new Set([1]),
      payload({}).properties,
      quiet,
    ),
  ).toThrow(/4 surface triangles but 3 face ids/);
});

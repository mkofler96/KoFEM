// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Suppressed bodies leave the volume part of a mesh; whether anything is left
// to analyse is decided on the whole stored model, the volume part plus the
// CAD mid-surface of a Shell body (KOF-498).

import { describe, expect, test } from "bun:test";
import type { FemMesh } from "../../src/wasm/pkg/kofem_wasm";
import { storedMesh } from "../../src/lib/storedMesh";
import { dropSuppressedBodies } from "../../src/lib/suppressBodies";

// One tetrahedron in body 2.
const solid = {
  vertices: new Float64Array([0, 0, 2, 1, 0, 2, 0, 1, 2, 0, 0, 3]),
  tetrahedra: new Int32Array([0, 1, 2, 3]),
  bodyIds: new Int32Array([2]),
  surfaceTriangles: new Int32Array([0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]),
  surfaceFaceIds: new Int32Array([9, 9, 9, 9]),
};

// One facet of body 1's mid-surface: top face 5, bottom face 6, side faces 3,
// 4 and 7.
const midSurface = {
  vertices: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  triangles: new Int32Array([0, 1, 2]),
  midFace: new Int32Array([0]),
  faces: [
    {
      body: 1,
      top: 5,
      bottom: 6,
      thickness: 1,
      topAreaRatio: 1,
      bottomAreaRatio: 1,
    },
  ],
  rimEdges: new Int32Array([0, 1, 3, 1, 2, 4, 2, 0, 7]),
};

const properties = [
  { id: 1, materialId: 1, discretization: "shell" as const },
  { id: 2, materialId: 1 },
];
const quiet = () => undefined;

describe("suppressed bodies", () => {
  test("leaving every element out of a volume part leaves it empty", () => {
    expect(
      dropSuppressedBodies(
        {
          nodes: [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }],
          elements: [{ id: 0, nodeIds: [0, 1, 2, 3], propertyId: 2 }],
          surfaceTriangles: [[0, 1, 2]],
          surfaceFaceIds: [9],
        },
        new Set([2]),
      ),
    ).toEqual({
      nodes: [],
      elements: [],
      surfaceTriangles: [],
      surfaceFaceIds: [],
    });
  });

  test("a model with every body suppressed is refused, naming them", () => {
    const dto: FemMesh = solid;
    expect(() =>
      storedMesh(
        dto,
        { properties, suppressedBodyIds: [2], shellBodyIds: new Set() },
        quiet,
      ),
    ).toThrow("Every body of the mesh is suppressed (bodies 2)");
  });

  test("a CAD mid-surface next to a suppressed solid is the whole model", () => {
    const dto: FemMesh = { ...solid, midSurface };
    const mesh = storedMesh(
      dto,
      { properties, suppressedBodyIds: [2], shellBodyIds: new Set([1]) },
      quiet,
    );
    expect(mesh.elements.map((e) => e.type)).toEqual(["CTRIA3"]);
    expect(mesh.nodes.length).toBe(3);
  });
});

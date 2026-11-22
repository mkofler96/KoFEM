// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the viewport draws of a FEM mesh, through the Rust module as
// lib/meshOutline.ts calls it (KOF-457): the outer faces (a face one element
// uses), every element edge once, and the line segments for a set of edges.
// Elements name nodes by id, which need not be their index. The numerics are
// covered in crates/kofem-fem/tests/mesh_outline.rs.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  edgeSegmentPositions,
  meshEdges,
  meshOuterFaces,
  outlineEdges,
} from "../../src/lib/meshOutline.ts";
import { loadFem } from "../support/wasm.mjs";

beforeAll(async () => {
  await loadFem();
});

const tet = (id, nodeIds) => ({ id, type: "CTETRA", nodeIds, propertyId: 1 });
const hex = (id, nodeIds) => ({ id, type: "CHEXA", nodeIds, propertyId: 1 });
const tri = (id, nodeIds) => ({ id, type: "CTRIA3", nodeIds, propertyId: 2 });

// Two tets sharing the face (11, 12, 13); node ids start at 10.
const TETS = [tet(1, [10, 11, 12, 13]), tet(2, [11, 12, 13, 14])];
// Two hexes sharing a face, in CHEXA order; node ids from 100.
const HEXES = [
  hex(3, [100, 101, 102, 103, 104, 105, 106, 107]),
  hex(4, [101, 108, 109, 102, 105, 110, 111, 106]),
];

describe("outer faces", () => {
  test("a face two tets share is not drawn", () => {
    const { triangles, quadrilaterals } = meshOuterFaces(TETS, []);
    expect(quadrilaterals).toEqual([]);
    expect(triangles).toEqual([
      [10, 11, 12],
      [10, 11, 13],
      [10, 12, 13],
      [11, 12, 14],
      [11, 13, 14],
      [12, 13, 14],
    ]);
  });

  test("a face two hexes share is not drawn", () => {
    const { triangles, quadrilaterals } = meshOuterFaces([], HEXES);
    expect(triangles).toEqual([]);
    expect(quadrilaterals).toHaveLength(10);
    expect(quadrilaterals[0]).toEqual([100, 101, 102, 103]);
  });

  test("a node id that is not a non-negative integer is refused", () => {
    expect(() => meshOuterFaces([tet(1, [0, 1, 2, -3])], [])).toThrow(
      /element 1 names node id -3/,
    );
    expect(() => meshOuterFaces([tet(1, [0, 1, 2])], [])).toThrow(
      /element 1 has 3 nodes; a CTETRA needs 4/,
    );
  });
});

describe("edges", () => {
  test("an edge several elements share comes once", () => {
    // 6 + 6 tet edges, 3 shared; 3 shell edges, one along a tet edge.
    const edges = meshEdges(TETS, [], [tri(5, [10, 11, 20])]);
    expect(edges.length).toBe(2 * (9 + 2));
  });

  test("the outline of the outer faces", () => {
    const { triangles, quadrilaterals } = meshOuterFaces(TETS, HEXES);
    // Two tets: 9 edges, all on the outside. Two hexes: 20 edges.
    expect(outlineEdges(triangles, quadrilaterals).length).toBe(2 * (9 + 20));
  });

  test("segments run between the nodes, displaced when asked", () => {
    const nodeMap = new Map([
      [7, { n: { id: 7, x: 0, y: 0, z: 0 }, i: 0 }],
      [9, { n: { id: 9, x: 1, y: 2, z: 3 }, i: 1 }],
    ]);
    const edges = Uint32Array.of(7, 9);
    expect(Array.from(edgeSegmentPositions(edges, nodeMap, null, 1))).toEqual([
      0, 0, 0, 1, 2, 3,
    ]);
    const displacements = Float64Array.of(1, 0, 0, 0, 0, -1);
    expect(
      Array.from(edgeSegmentPositions(edges, nodeMap, displacements, 2)),
    ).toEqual([2, 0, 0, 1, 2, 1]);
    expect(() =>
      edgeSegmentPositions(Uint32Array.of(7, 8), nodeMap, null, 1),
    ).toThrow(/node id 8/);
  });
});

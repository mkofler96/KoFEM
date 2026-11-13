// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The CAD faces a shell idealisation collapses onto the rim of its
// mid-surface (src/lib/shellRim.ts): each rim edge of the shell facets is
// matched to the side face of the geometry it lies on, so an edge pick can
// select (and a re-mesh can find again) that face's whole rim.

import { describe, expect, test } from "bun:test";
import {
  modelShellRim,
  rimEdgeKey,
  shellRimFaces,
} from "../../src/lib/shellRim.ts";

// The display tessellation of a box [0, w] × [0, w] × [0, t], two triangles per
// face, each face on its own vertices (as OCCT tessellates): 1 y = 0,
// 2 x = w, 3 y = w, 4 x = 0, 5 z = 0, 6 z = t.
function boxTessellation(w, t) {
  const quads = [
    [
      [0, 0, 0],
      [w, 0, 0],
      [w, 0, t],
      [0, 0, t],
    ],
    [
      [w, 0, 0],
      [w, w, 0],
      [w, w, t],
      [w, 0, t],
    ],
    [
      [w, w, 0],
      [0, w, 0],
      [0, w, t],
      [w, w, t],
    ],
    [
      [0, w, 0],
      [0, 0, 0],
      [0, 0, t],
      [0, w, t],
    ],
    [
      [0, 0, 0],
      [0, w, 0],
      [w, w, 0],
      [w, 0, 0],
    ],
    [
      [0, 0, t],
      [w, 0, t],
      [w, w, t],
      [0, w, t],
    ],
  ];
  const points = [];
  const triangles = [];
  const faceIds = [];
  quads.forEach((quad, f) => {
    const base = points.length;
    points.push(...quad);
    triangles.push([base, base + 1, base + 2], [base, base + 2, base + 3]);
    faceIds.push(f + 1, f + 1);
  });
  return { points, triangles, faceIds };
}

// The box's mid-surface as a shell: an n × n grid of quads at z = t/2, each
// split in two; every facet carries CAD face 5 (the kept wall face).
function midSurface(w, t, n) {
  const nodes = [];
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++)
      nodes.push({
        id: 100 + j * (n + 1) + i,
        x: (w * i) / n,
        y: (w * j) / n,
        z: t / 2,
      });
  const id = (i, j) => 100 + j * (n + 1) + i;
  const elements = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      elements.push(
        { type: "CTRIA3", nodeIds: [id(i, j), id(i + 1, j), id(i + 1, j + 1)] },
        { type: "CTRIA3", nodeIds: [id(i, j), id(i + 1, j + 1), id(i, j + 1)] },
      );
    }
  const surfaceTriangles = elements.map((e) => [...e.nodeIds]);
  return {
    nodes,
    elements,
    surfaceTriangles,
    surfaceFaceIds: surfaceTriangles.map(() => 5),
    id,
  };
}

describe("a 2 mm wall on a 100 mm square", () => {
  const n = 4;
  const { id, ...model } = midSurface(100, 2, n);
  const rim = shellRimFaces(model, boxTessellation(100, 2));
  const line = (pick) =>
    Array.from({ length: n + 1 }, (_, k) => pick(k)).sort((a, b) => a - b);

  test("each side face collapses to its own rim edge, corner to corner", () => {
    const found = JSON.stringify([...rim.nodesByFace]);
    expect(rim.nodesByFace.get(1), found).toEqual(line((k) => id(k, 0)));
    expect(rim.nodesByFace.get(2), found).toEqual(line((k) => id(n, k)));
    expect(rim.nodesByFace.get(3), found).toEqual(line((k) => id(k, n)));
    expect(rim.nodesByFace.get(4), found).toEqual(line((k) => id(0, k)));
  });

  test("the wall faces are not rim faces", () => {
    expect(rim.nodesByFace.has(5)).toBe(false);
    expect(rim.nodesByFace.has(6)).toBe(false);
  });

  test("every rim edge has its face, and no inner edge is a rim edge", () => {
    expect(rim.faceOfEdge.size).toBe(4 * n);
    expect(rim.faceOfEdge.get(rimEdgeKey(id(n, 1), id(n, 2)))).toBe(2);
    expect(rim.faceOfEdge.get(rimEdgeKey(id(1, 0), id(0, 0)))).toBe(1);
    expect(rim.faceOfEdge.has(rimEdgeKey(id(1, 1), id(2, 1)))).toBe(false);
  });
});

// ── A wall thinner than the tessellation's chord tolerance ───────────────────
// 0.2 mm on a 200 mm square: the far wall face z = 0.2 is within the tolerance
// (0.001 × the 283 mm diagonal) of every rim node too, so the rim edge's own
// side face is told apart by its midpoint, which lies on it.
test("a wall thinner than the tolerance still finds its side faces", () => {
  const { id, ...model } = midSurface(200, 0.2, 2);
  const rim = shellRimFaces(model, boxTessellation(200, 0.2));
  const found = JSON.stringify([...rim.nodesByFace]);
  expect(rim.nodesByFace.get(2), found).toEqual([id(2, 0), id(2, 1), id(2, 2)]);
  expect(rim.nodesByFace.has(6), found).toBe(false);
});

describe("no shell, or no CAD face ids", () => {
  const { id: _id, ...model } = midSurface(100, 2, 2);

  test("a model without shell facets has no rim", () => {
    const solid = { ...model, elements: [] };
    const rim = shellRimFaces(solid, boxTessellation(100, 2));
    expect(rim.nodesByFace.size).toBe(0);
  });

  test("a geometry without CAD face ids gives no rim", () => {
    const { faceIds: _faceIds, ...noIds } = boxTessellation(100, 2);
    expect(modelShellRim(model, noIds).nodesByFace.size).toBe(0);
    expect(modelShellRim(model, null).nodesByFace.size).toBe(0);
  });
});

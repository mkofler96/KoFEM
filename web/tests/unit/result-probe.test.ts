// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/resultProbe.ts (KOF-389): a probe placed by clicking
// the result reads the plotted field and the displacement vector at a surface
// point. It is anchored to the CAD face it was placed on, so after a re-mesh
// it reads the same point on that face's new triangles. The browser path is
// covered by tests/result-probe.spec.ts.

import { describe, expect, test } from "bun:test";
import {
  fieldExtremes,
  readProbes,
  undeformedPoint,
  type ProbeModel,
  type ResultProbe,
} from "../../src/lib/resultProbe";
import type { Element, Node } from "../../src/store/modelStore";

type Vec3 = [number, number, number];

// A linear displacement field: any triangulation interpolates it exactly, so a
// probe reads the same value on every mesh of the face.
const field = ([x, y, z]: Vec3): Vec3 => [
  0.001 * x + 0.002 * y,
  -0.003 * x,
  0.0005 * z + 0.004 * y,
];

function model(
  points: [number, Vec3][],
  surfaceTriangles: [number, number, number][],
  surfaceFaceIds: number[],
  elements: Element[] = [],
  vonMises?: number[],
): ProbeModel {
  const nodes: Node[] = points.map(([id, [x, y, z]]) => ({ id, x, y, z }));
  const displacements = new Float64Array(
    points.flatMap(([, point]) => field(point)),
  );
  return {
    nodes,
    elements,
    surfaceTriangles,
    surfaceFaceIds,
    result: {
      displacements,
      ...(vonMises ? { vonMises: new Float64Array(vonMises) } : {}),
    },
  };
}

// CAD face 1: the square z = 0, 0 ≤ x, y ≤ 10. CAD face 2: the square x = 10,
// 0 ≤ y, z ≤ 10. They share the edge x = 10, z = 0.
const coarse = model(
  [
    [1, [0, 0, 0]],
    [2, [10, 0, 0]],
    [3, [10, 10, 0]],
    [4, [0, 10, 0]],
    [5, [10, 0, 10]],
    [6, [10, 10, 10]],
  ],
  [
    [1, 2, 3],
    [1, 3, 4],
    [2, 5, 6],
    [2, 6, 3],
  ],
  [1, 1, 2, 2],
);

// The same two faces meshed again: other node ids, a centre node on face 1.
const fine = model(
  [
    [11, [0, 0, 0]],
    [12, [10, 0, 0]],
    [13, [10, 10, 0]],
    [14, [0, 10, 0]],
    [15, [5, 5, 0]],
    [16, [10, 0, 10]],
    [17, [10, 10, 10]],
  ],
  [
    [11, 12, 15],
    [12, 13, 15],
    [13, 14, 15],
    [14, 11, 15],
    [12, 16, 17],
    [12, 17, 13],
  ],
  [1, 1, 1, 1, 2, 2],
);

const onFace = (id: number, point: Vec3, cadFaceId: number): ResultProbe => ({
  id,
  point,
  cadFaceId,
});

function expectValue(
  reading: ReturnType<typeof readProbes>[number],
): Extract<typeof reading, { kind: "value" }> {
  if (reading.kind !== "value")
    throw new Error(`expected a value, got: ${reading.reason}`);
  return reading;
}

const expectVec = (actual: number[], expected: number[]) =>
  expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 12));

describe("readProbes", () => {
  test("reads the field and the displacement vector at a node", () => {
    const [reading] = readProbes(
      [onFace(1, [10, 10, 0], 1)],
      coarse,
      "Ux",
      "top",
    );
    const value = expectValue(reading);
    expectVec(value.at, [10, 10, 0]);
    expectVec(value.displacement, field([10, 10, 0]));
    expect(value.value).toBeCloseTo(field([10, 10, 0])[0], 12);
  });

  test("interpolates inside a triangle", () => {
    const point: Vec3 = [7, 2, 0];
    const [reading] = readProbes([onFace(1, point, 1)], coarse, "Uz", "top");
    const value = expectValue(reading);
    expectVec(value.displacement, field(point));
    expect(value.value).toBeCloseTo(field(point)[2], 12);
  });

  test("the magnitude is interpolated as the colour map draws it, from the nodes' magnitudes", () => {
    const corners: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ];
    const centroid: Vec3 = [20 / 3, 10 / 3, 0];
    const norm = (v: Vec3) => Math.hypot(...v);
    const [reading] = readProbes(
      [onFace(1, centroid, 1)],
      coarse,
      "Displacement (magnitude)",
      "top",
    );
    const expected =
      corners.reduce((sum, corner) => sum + norm(field(corner)), 0) / 3;
    expect(expectValue(reading).value).toBeCloseTo(expected, 12);
  });

  test("a point off the face reads the nearest point of its own CAD face", () => {
    // Nearer to face 1 than to face 2, but the probe was placed on face 2.
    const [reading] = readProbes(
      [onFace(1, [9, 5, 0.1], 2)],
      coarse,
      "Uy",
      "top",
    );
    const value = expectValue(reading);
    expectVec(value.at, [10, 5, 0.1]);
    expectVec(value.displacement, field([10, 5, 0.1]));
  });

  test("after a re-mesh the probe reads the same point of its CAD face on the new triangles", () => {
    const probes = [onFace(1, [2, 3, 0], 1), onFace(2, [10, 4, 6], 2)];
    const before = readProbes(probes, coarse, "Uz", "top").map(expectValue);
    const after = readProbes(probes, fine, "Uz", "top").map(expectValue);
    after.forEach((value, i) => {
      expectVec(value.at, before[i].at);
      expectVec(value.displacement, field(probes[i].point));
      expect(value.value).toBeCloseTo(before[i].value, 12);
    });
  });

  test("a CAD face the mesh no longer has is unreadable, with the reason", () => {
    const [reading] = readProbes(
      [onFace(1, [5, 5, 0], 7)],
      coarse,
      "Ux",
      "top",
    );
    expect(reading).toEqual({
      kind: "unreadable",
      reason: "CAD face 7 is not on the current mesh's surface.",
    });
  });

  test("a probe placed where the mesh has no CAD face reads its own triangle", () => {
    const probe: ResultProbe = {
      id: 1,
      point: [10, 4, 6],
      triangle: [2, 5, 6],
    };
    const [reading] = readProbes([probe], coarse, "Ux", "top");
    expectVec(expectValue(reading).displacement, field([10, 4, 6]));
    // That triangle's nodes are gone after a re-mesh.
    const [stale] = readProbes([probe], fine, "Ux", "top");
    expect(stale).toEqual({
      kind: "unreadable",
      reason: "Its triangle refers to node 2, which is not in the mesh.",
    });
  });

  test("a result of another mesh is unreadable", () => {
    const stale: ProbeModel = {
      ...fine,
      result: coarse.result,
    };
    const [reading] = readProbes([onFace(1, [5, 5, 0], 1)], stale, "Ux", "top");
    expect(reading).toEqual({
      kind: "unreadable",
      reason:
        "The result has 18 displacement values for 7 nodes; it belongs to a different mesh.",
    });
  });

  test("reads the node-averaged von Mises stress of a shell", () => {
    // Two shell facets of equal area on face 1, carrying 100 and 200 MPa:
    // nodes 1 and 3 are shared and average to 150.
    const shell = model(
      [
        [1, [0, 0, 0]],
        [2, [10, 0, 0]],
        [3, [10, 10, 0]],
        [4, [0, 10, 0]],
      ],
      [
        [1, 2, 3],
        [1, 3, 4],
      ],
      [1, 1],
      [
        { id: 1, type: "CTRIA3", nodeIds: [1, 2, 3], propertyId: 2 },
        { id: 2, type: "CTRIA3", nodeIds: [1, 3, 4], propertyId: 2 },
      ],
      [100, 200],
    );
    const probes = [
      onFace(1, [10, 0, 0], 1),
      onFace(2, [20 / 3, 10 / 3, 0], 1),
    ];
    const [atNode, inside] = readProbes(
      probes,
      shell,
      "Von Mises stress",
      "top",
    ).map(expectValue);
    expect(atNode.value).toBeCloseTo(100, 12);
    expect(inside.value).toBeCloseTo((150 + 100 + 150) / 3, 12);
  });

  test("von Mises without stress data is unreadable", () => {
    const [reading] = readProbes(
      [onFace(1, [5, 5, 0], 1)],
      coarse,
      "Von Mises stress",
      "top",
    );
    expect(reading).toEqual({
      kind: "unreadable",
      reason: "The result has no von Mises stress.",
    });
  });
});

describe("fieldExtremes", () => {
  // The min/max probes: the nodes where the plotted field is lowest and
  // highest, the values the legend and the Result summary show.
  test("finds the nodes of the field's min and max, the first one on a tie", () => {
    // Ux = 0.001·x + 0.002·y: lowest at node 1, highest at nodes 3 and 6.
    const { min, max } = fieldExtremes(coarse, "Ux", "top");
    expect(min.nodeId).toBe(1);
    expect(min.value).toBeCloseTo(0, 12);
    expectVec(min.at, [0, 0, 0]);
    expect(max.nodeId).toBe(3);
    expect(max.value).toBeCloseTo(0.03, 12);
    expectVec(max.at, [10, 10, 0]);
    expectVec(max.displacement, field([10, 10, 0]));
  });

  test("follows the plotted field", () => {
    // Uy = −0.003·x: lowest on x = 10 (node 2 first), highest on x = 0.
    const { min, max } = fieldExtremes(coarse, "Uy", "top");
    expect(min.nodeId).toBe(2);
    expect(min.value).toBeCloseTo(-0.03, 12);
    expect(max.nodeId).toBe(1);
  });

  test("a result of another mesh is an error", () => {
    expect(() =>
      fieldExtremes({ ...fine, result: coarse.result }, "Ux", "top"),
    ).toThrow(
      "The result has 18 displacement values for 7 nodes; it belongs to a different mesh.",
    );
  });
});

describe("undeformedPoint", () => {
  test("maps a point on the deformed triangle back onto the undeformed one", () => {
    const undeformed: [Vec3, Vec3, Vec3] = [
      [0, 0, 0],
      [10, 0, 0],
      [0, 10, 0],
    ];
    const deformed: [Vec3, Vec3, Vec3] = [
      [1, 0, 2],
      [12, 1, 2],
      [1, 9, 3],
    ];
    // 0.2·a + 0.5·b + 0.3·c on the deformed triangle.
    const clicked: Vec3 = [
      0.2 * 1 + 0.5 * 12 + 0.3 * 1,
      0.5 * 1 + 0.3 * 9,
      0.2 * 2 + 0.5 * 2 + 0.3 * 3,
    ];
    expectVec(undeformedPoint(deformed, undeformed, clicked), [5, 3, 0]);
  });
});

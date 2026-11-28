// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the status bar is about (KOF-493): while any tool picks faces (a
// support, load, tie or coupling; a mesh face size; a face split) it describes
// the CAD face picked last, and nothing else. Otherwise it shows the counts of
// the step the model tree is on: the mesh's in Mesh, the supports' and loads'
// in Boundary conditions, none elsewhere.

import { describe, expect, test } from "bun:test";
import {
  isPicking,
  pickedCadFaceId,
  stepCounts,
} from "../../src/lib/statusContext";
import type { StatusPickState } from "../../src/lib/statusContext";

const idle: StatusPickState = {
  pickMode: null,
  pickGeometry: "face",
  selectedFace: null,
  faceSizePicking: false,
  faceSizePickIds: [],
  splitPicking: false,
  splitFaceIds: [],
};

describe("isPicking", () => {
  test("no tool picks", () => {
    expect(isPicking(idle)).toBe(false);
  });

  test("a support, load, tie or coupling picks", () => {
    expect(isPicking({ ...idle, pickMode: "bc" })).toBe(true);
  });

  test("a mesh face size picks", () => {
    expect(isPicking({ ...idle, faceSizePicking: true })).toBe(true);
  });

  test("a face split picks", () => {
    expect(isPicking({ ...idle, splitPicking: true })).toBe(true);
  });
});

describe("pickedCadFaceId", () => {
  test("nothing picked yet", () => {
    expect(pickedCadFaceId({ ...idle, pickMode: "load" })).toBeUndefined();
  });

  test("a face pick for a support gives its CAD face", () => {
    expect(
      pickedCadFaceId({
        ...idle,
        pickMode: "bc",
        selectedFace: { cadFaceId: 39 },
      }),
    ).toBe(39);
  });

  test("an edge pick describes no face", () => {
    expect(
      pickedCadFaceId({
        ...idle,
        pickMode: "bc",
        pickGeometry: "edge",
        selectedFace: { cadFaceId: 5 },
      }),
    ).toBeUndefined();
  });

  test("a face pick without a CAD face (a mesh with none) describes none", () => {
    expect(
      pickedCadFaceId({ ...idle, pickMode: "bc", selectedFace: {} }),
    ).toBeUndefined();
  });

  test("face sizes give the face picked last", () => {
    expect(
      pickedCadFaceId({
        ...idle,
        faceSizePicking: true,
        faceSizePickIds: [4, 12],
      }),
    ).toBe(12);
  });

  test("a face split gives the face picked last", () => {
    expect(
      pickedCadFaceId({ ...idle, splitPicking: true, splitFaceIds: [7, 3] }),
    ).toBe(3);
  });
});

describe("stepCounts", () => {
  const counts = {
    nodes: 3144,
    hexes: 0,
    tets: 9570,
    fixedNodes: 75,
    faceLoads: 1,
    nodalLoadDofs: 150,
  };

  test("the Mesh step shows the mesh's nodes and elements", () => {
    expect(stepCounts("mesh", counts)).toEqual([
      { kind: "nodes", value: 3144 },
      { kind: "tets", value: 9570 },
    ]);
  });

  test("Boundary conditions show fixed nodes and loads, face loads first", () => {
    expect(stepCounts("boundary", counts)).toEqual([
      { kind: "fixedNodes", value: 75 },
      { kind: "faceLoads", value: 1 },
      { kind: "nodalLoadDofs", value: 150 },
    ]);
  });

  test("other steps show no counts", () => {
    for (const group of [
      "geometry",
      "materials",
      "studies",
      "results",
    ] as const)
      expect(stepCounts(group, counts)).toEqual([]);
  });

  test("a count of zero is left out", () => {
    expect(
      stepCounts("boundary", { ...counts, fixedNodes: 0, nodalLoadDofs: 0 }),
    ).toEqual([{ kind: "faceLoads", value: 1 }]);
  });
});

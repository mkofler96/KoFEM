// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What the status bar is about (KOF-493): while any tool picks faces (a
// support, load, tie or coupling; a mesh face size; a face split) it describes
// the CAD face picked last, and nothing else.

import { describe, expect, test } from "bun:test";
import { isPicking, pickedCadFaceId } from "../../src/lib/statusContext";
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

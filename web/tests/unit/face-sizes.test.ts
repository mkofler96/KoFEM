// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Element sizes on selected CAD faces (KOF-394, src/lib/faceSizes.ts): picking
// faces into a size, validating the sizes a mesh request takes, and telling
// whether the settings still match the mesh.

import { describe, expect, test } from "bun:test";
import {
  assignFaceSize,
  faceSizesMatch,
  parseFaceSizes,
} from "../../src/lib/faceSizes";
import { levelSizes } from "../../src/lib/refinementStudy";

describe("assignFaceSize", () => {
  test("adds the picked faces as one entry, in face order", () => {
    expect(assignFaceSize([], [7, 3], "0.5")).toEqual([
      { faceIds: [3, 7], size: "0.5" },
    ]);
  });

  test("a face picked again moves to the new size", () => {
    const entries = [
      { faceIds: [3, 7], size: "0.5" },
      { faceIds: [9], size: "1" },
    ];
    expect(assignFaceSize(entries, [7, 9], "2")).toEqual([
      { faceIds: [3], size: "0.5" },
      { faceIds: [7, 9], size: "2" },
    ]);
  });

  test("no picked face is an error", () => {
    expect(() => assignFaceSize([], [], "1")).toThrow(/no face/i);
  });
});

describe("parseFaceSizes", () => {
  test("maps every face to its size", () => {
    expect(
      parseFaceSizes(
        [
          { faceIds: [3, 7], size: "0.5" },
          { faceIds: [9], size: " 1.5 " },
        ],
        0.1,
      ),
    ).toEqual({ 3: 0.5, 7: 0.5, 9: 1.5 });
  });

  test("a size that is not a positive number is refused", () => {
    expect(() => parseFaceSizes([{ faceIds: [3], size: "0" }], 0)).toThrow(
      "Face size 0 mm",
    );
    expect(() => parseFaceSizes([{ faceIds: [3], size: "-1" }], 0)).toThrow(
      "Face size -1 mm",
    );
    expect(() => parseFaceSizes([{ faceIds: [3], size: "abc" }], 0)).toThrow(
      "Face size abc mm",
    );
  });

  test("a size below the min element size is refused", () => {
    expect(() => parseFaceSizes([{ faceIds: [3], size: "0.5" }], 1)).toThrow(
      /Min element size \(1 mm\)/,
    );
  });
});

describe("faceSizesMatch", () => {
  test("matches the sizes a mesh was made with", () => {
    expect(
      faceSizesMatch([{ faceIds: [3, 7], size: "0.5" }], { 3: 0.5, 7: 0.5 }),
    ).toBe(true);
    expect(faceSizesMatch([], {})).toBe(true);
  });

  test("a changed, added or removed face size does not match", () => {
    expect(faceSizesMatch([{ faceIds: [3], size: "0.6" }], { 3: 0.5 })).toBe(
      false,
    );
    expect(faceSizesMatch([{ faceIds: [3, 7], size: "0.5" }], { 3: 0.5 })).toBe(
      false,
    );
    expect(faceSizesMatch([], { 3: 0.5 })).toBe(false);
  });
});

describe("a refinement study refines the face sizes too", () => {
  test("each level divides every face size by the ratio", () => {
    const base = { max: 8, min: 0.8, regions: {}, faces: { 3: 2 } };
    expect(levelSizes(base, 1, 2).faces).toEqual({ 3: 1 });
  });
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The repair suggestion for a mesh that overlapped itself: which overlaps are
// offered, and the width it starts from.

import { describe, expect, test } from "bun:test";
import {
  coneTipFaces,
  defaultRepairWidth,
  hingeRepairs,
  narrowestUnmeshedWidth,
  removableUnmeshedFaces,
  soupOutline,
  unmeshedFaces,
} from "../../src/lib/meshOverlaps.ts";

const hinge = {
  kind: "hinge",
  faceIds: new Int32Array([46, 54]),
  bodyId: 2,
  positions: new Float64Array(9),
  hinge: {
    start: new Float64Array([-9, 21.05, 5.9]),
    end: new Float64Array([-9, 21.05, 13.24]),
    normal: new Float64Array([1, 0, 0]),
    length: 7.34,
  },
};
const surface = {
  kind: "surface",
  faceIds: new Int32Array([172]),
  bodyId: 1,
  positions: new Float64Array(9),
};
const cone = { ...surface, kind: "cone", faceIds: new Int32Array([7, 8]) };
// Faces the mesher gave up on.
const unmeshed = {
  ...surface,
  kind: "unmeshed",
  faceIds: new Int32Array([60]),
  width: 0.01,
};
const unmeshedToo = {
  ...unmeshed,
  faceIds: new Int32Array([113]),
  width: 0.001,
};

describe("hinge repairs", () => {
  test("only hinges are repairable, as plain arrays the engine's JSON can carry", () => {
    expect(hingeRepairs([surface, hinge])).toEqual([
      {
        bodyId: 2,
        start: [-9, 21.05, 5.9],
        end: [-9, 21.05, 13.24],
        normal: [1, 0, 0],
      },
    ]);
  });

  test("no hinge overlap offers no hinge repair", () => {
    expect(hingeRepairs([surface])).toEqual([]);
  });

  test("an unmeshed face offers no hinge repair", () => {
    expect(hingeRepairs([unmeshed])).toEqual([]);
  });
});

describe("cone tip faces", () => {
  test("only cone overlaps offer their faces for the cone split", () => {
    expect(coneTipFaces([surface, hinge, cone])).toEqual([7, 8]);
  });

  test("no cone overlap offers no faces", () => {
    expect(coneTipFaces([surface, hinge])).toEqual([]);
  });

  test("separate overlaps on one face still name it once: the engine refuses duplicates", () => {
    const sameFace = { ...cone, faceIds: new Int32Array([8, 9]) };
    expect(coneTipFaces([cone, sameFace])).toEqual([7, 8, 9]);
  });

  test("an unmeshed face offers no cone tip face", () => {
    expect(coneTipFaces([unmeshed])).toEqual([]);
  });
});

describe("unmeshed faces", () => {
  test("faces the mesher gave up on are counted once each, apart from overlaps", () => {
    expect(
      unmeshedFaces([surface, hinge, cone, unmeshed, unmeshedToo]),
    ).toEqual([60, 113]);
  });

  test("the same unmeshed face twice is named once", () => {
    expect(unmeshedFaces([unmeshed, unmeshed])).toEqual([60]);
  });

  test("overlaps that are not unmeshed offer no unmeshed faces", () => {
    expect(unmeshedFaces([surface, hinge, cone])).toEqual([]);
  });

  test("the message quotes the narrowest unmeshed width", () => {
    expect(narrowestUnmeshedWidth([surface, unmeshed, unmeshedToo])).toBe(
      0.001,
    );
  });

  test("no unmeshed face has no narrowest width", () => {
    expect(narrowestUnmeshedWidth([surface, hinge])).toBeNull();
  });

  test("an unmeshed face without a width is a bug", () => {
    expect(() =>
      narrowestUnmeshedWidth([{ ...unmeshed, width: undefined }]),
    ).toThrow();
  });
});

describe("removable unmeshed faces", () => {
  // Only faces narrower than the minimum element size are offered for removal:
  // a wider face needs smaller elements, not a different shape.
  const wide = { ...unmeshed, faceIds: new Int32Array([6]), width: 7.3 };

  test("only faces narrower than the minimum element size are offered", () => {
    expect(
      removableUnmeshedFaces([unmeshed, unmeshedToo, wide, hinge], "0.12"),
    ).toEqual([60, 113]);
  });

  test("a wider face offers nothing", () => {
    expect(removableUnmeshedFaces([wide], "2")).toEqual([]);
  });

  test("a blank minimum element size offers nothing", () => {
    expect(removableUnmeshedFaces([unmeshed], "")).toEqual([]);
  });

  test("a zero minimum element size offers nothing", () => {
    expect(removableUnmeshedFaces([unmeshed], "0")).toEqual([]);
  });
});

describe("face outline from a triangle soup", () => {
  // A unit square of two triangles has four boundary edges; the shared
  // diagonal is not one of them.
  const square = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];

  test("a unit square has four boundary edges", () => {
    expect(soupOutline(square)).toHaveLength(4 * 6);
  });

  test("the diagonal is not an outline edge", () => {
    const outline = soupOutline(square);
    for (let at = 0; at < outline.length; at += 6) {
      const [startX, startY, , endX, endY] = outline.slice(at, at + 6);
      expect(
        !(startX !== endX && startY !== endY),
        "the diagonal is not an outline edge",
      ).toBe(true);
    }
  });

  test("a soup that is not whole triangles throws", () => {
    expect(() => soupOutline([0, 0, 0])).toThrow();
  });
});

describe("default repair width", () => {
  test("the width follows the element size", () => {
    expect(defaultRepairWidth("2")).toBe("3");
    expect(defaultRepairWidth("0.333333")).toBe("0.5");
  });

  test("no usable size means the field asks", () => {
    expect(defaultRepairWidth("")).toBe("");
    expect(defaultRepairWidth("0")).toBe("");
    expect(defaultRepairWidth("-1")).toBe("");
  });
});

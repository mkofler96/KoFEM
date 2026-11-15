// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the geometry view's CAD-face helpers (src/lib/cadFaces.ts):
// the face outline that makes a split visible, the picked-face overlay and the
// cutting-plane preview.

import { describe, expect, test } from "bun:test";
import {
  cadFaceOutline,
  cadFaceTriangles,
  planePreview,
  tessellationBounds,
} from "../../src/lib/cadFaces.ts";

// A 10 × 4 strip split at x = 5 into two CAD faces, tessellated the way OCCT
// does it: each face on its own vertex set (face 1: 0–3, face 2: 4–7), so the
// split line x = 5 exists twice, once per face.
const surface = {
  points: [
    [0, 0, 0],
    [5, 0, 0],
    [5, 4, 0],
    [0, 4, 0],
    [5, 0, 0],
    [10, 0, 0],
    [10, 4, 0],
    [5, 4, 0],
  ],
  triangles: [
    [0, 1, 2],
    [0, 2, 3],
    [4, 5, 6],
    [4, 6, 7],
  ],
  faceIds: [1, 1, 2, 2],
};

describe("face outline", () => {
  const outline = cadFaceOutline(surface);

  test("each face's 4 boundary edges, none of its diagonals", () => {
    expect(outline.length / 6).toBe(8);
  });

  test("the split line is drawn (once per face)", () => {
    let atSplit = 0;
    for (let offset = 0; offset < outline.length; offset += 6)
      if (outline[offset] === 5 && outline[offset + 3] === 5) atSplit++;
    expect(atSplit).toBe(2);
  });

  test("restricted to one face's triangles, only its outline", () => {
    const body = cadFaceOutline(surface, [2, 3]);
    expect(body.length / 6).toBe(4);
  });
});

describe("picked-face overlay", () => {
  const picked = cadFaceTriangles(surface, [2]);

  test("holds that face's two triangles", () => {
    expect(picked).toHaveLength(18);
  });

  test("holds only its vertices", () => {
    const xs = [...picked].filter((_, index) => index % 3 === 0);
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(5);
  });
});

describe("tessellation bounds", () => {
  test("bounds span the tessellation", () => {
    expect(tessellationBounds(surface.points)).toEqual({
      min: [0, 0, 0],
      max: [10, 4, 0],
    });
  });

  test("an empty tessellation has no bounds", () => {
    expect(tessellationBounds([])).toBeNull();
  });
});

describe("cutting-plane preview", () => {
  const bounds = tessellationBounds(surface.points);
  const plane = planePreview(bounds, 0, 5);

  test("the plane preview lies on x = 5", () => {
    const xs = new Set([...plane].filter((_, index) => index % 3 === 0));
    expect(xs.size).toBe(1);
    expect(xs.has(5)).toBe(true);
  });

  test("the plane overhangs the model by a margin", () => {
    const ys = [...plane].filter((_, index) => index % 3 === 1);
    expect(
      Math.min(...ys),
      `${Math.min(...ys)}…${Math.max(...ys)}`,
    ).toBeLessThan(0);
    expect(
      Math.max(...ys),
      `${Math.min(...ys)}…${Math.max(...ys)}`,
    ).toBeGreaterThan(4);
  });
});

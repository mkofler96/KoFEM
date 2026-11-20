// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The result section cut through the Rust module, as the viewport calls it
// (KOF-390): sectionCut(points, values, tets, hexes, shellTriangles, axis,
// level, flipped). A unit cube carrying a linear field makes the cap's area
// and values exact; the numerics are covered in crates/kofem-fem/tests.

import { beforeAll, describe, expect, test } from "bun:test";
import { loadFem } from "../support/wasm.mjs";

let fem = null;
beforeAll(async () => {
  fem = await loadFem();
});

const corners = Array.from({ length: 8 }, (_, i) => [
  i & 1,
  (i >> 1) & 1,
  (i >> 2) & 1,
]);
const points = Float64Array.from(corners.flat());
const field = ([x, y, z]) => x + 2 * y + 3 * z;
const values = Float64Array.from(corners.map(field));
const tets = Uint32Array.from([
  0, 1, 3, 7, 0, 3, 2, 7, 0, 2, 6, 7, 0, 6, 4, 7, 0, 4, 5, 7, 0, 5, 1, 7,
]);
const none = new Uint32Array(0);

function area(cut) {
  const at = cut.capPoints;
  let total = 0;
  const triangles = cut.capTriangles;
  for (let k = 0; k < triangles.length; k += 3) {
    const [a, b, c] = [0, 1, 2].map((j) =>
      [0, 1, 2].map((i) => at[3 * triangles[k + j] + i]),
    );
    const ab = [0, 1, 2].map((i) => b[i] - a[i]);
    const ac = [0, 1, 2].map((i) => c[i] - a[i]);
    total +=
      Math.hypot(
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ) / 2;
  }
  return total;
}

describe("sectionCut", () => {
  test("fills the cube's cross-section with the interpolated field", () => {
    const cut = fem.sectionCut(
      points,
      values,
      tets,
      none,
      none,
      2,
      0.25,
      false,
    );
    expect(area(cut)).toBeCloseTo(1, 12);
    const at = cut.capPoints;
    cut.capValues.forEach((value, i) => {
      const point = [at[3 * i], at[3 * i + 1], at[3 * i + 2]];
      expect(point[2]).toBeCloseTo(0.25, 12);
      expect(value).toBeCloseTo(field(point), 12);
    });
    expect(cut.linePoints).toHaveLength(0);
  });

  test("cuts shell facets into lines", () => {
    const facets = Uint32Array.from([0, 1, 3, 0, 3, 2]);
    const cut = fem.sectionCut(
      points,
      values,
      none,
      none,
      facets,
      0,
      0.5,
      false,
    );
    expect(cut.linePoints).toHaveLength(12);
    expect(cut.lineValues).toHaveLength(4);
  });

  test("refuses a mismatched field by name", () => {
    expect(() =>
      fem.sectionCut(
        points,
        values.subarray(0, 7),
        tets,
        none,
        none,
        0,
        0.5,
        false,
      ),
    ).toThrow("7 values for 8 nodes");
  });
});

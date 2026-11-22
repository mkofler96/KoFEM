// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A recipe names a face by a point on it (examples/validation/lib/recipe.mjs
// resolveFaceAt). The display facets of a curved face cut inside it by up to
// the tessellation's deflection, so on a large model they can pass within
// that deflection of a narrow face beside them: the 40 mm rim of a 10 m
// shell (NAFEMS LE3). The point still names the face it lies on when every
// other face is clearly farther; a point near an edge stays ambiguous.

import { describe, expect, test } from "bun:test";
import {
  DEFLECTION_RELATIVE,
  resolveFaceAt,
} from "../../../examples/validation/lib/recipe.mjs";

// Face 1: a 40 mm strip on z = 0. Face 2: a facet of a curved face beside it,
// in the plane y = 8, which its true surface lies outside. Face 3: a far
// speck that sets the model's size to about 10.5 m.
const tess = {
  points: [
    [0, -20, 0],
    [1000, -20, 0],
    [1000, 20, 0],
    [0, 20, 0],
    [0, 8, -1000],
    [1000, 8, -1000],
    [500, 8, 1000],
    [9000, 5000, 0],
    [9000, 5001, 0],
    [9001, 5000, 0],
  ],
  triangles: [
    [0, 1, 2],
    [0, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ],
  faceIds: [1, 1, 2, 3],
};

describe("resolveFaceAt beside the facets of a curved face", () => {
  test("the facets lie within the deflection of the point", () => {
    // The case under test: both faces are within the tolerance.
    expect(8).toBeLessThan(DEFLECTION_RELATIVE * 10000);
  });

  test("a point on the narrow face names it", () => {
    expect(resolveFaceAt(tess, [500, 0, 0])).toBe(1);
  });

  test("a point about as near both faces is ambiguous", () => {
    expect(() => resolveFaceAt(tess, [500, 4, 0])).toThrow(/exactly one/);
  });
});

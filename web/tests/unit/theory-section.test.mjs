// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The section cut of the Theory Guide's result viewer (public/theory/
// section.js): a plane normal to one axis cuts the tetrahedra into a cap,
// coloured by the field interpolated linearly along the cut edges, and clips
// the boundary surface to the side below the plane. A unit cube of six
// tetrahedra carrying a linear field makes every area and value exact.

import { describe, expect, test } from "bun:test";
import {
  clipSurface,
  cutTets,
  sectionMesh,
} from "../../public/theory/section.js";

// The cube [0,1]³: corner i at (i & 1, (i >> 1) & 1, (i >> 2) & 1), cut into
// six tetrahedra about its 0–7 diagonal.
const corners = Array.from({ length: 8 }, (_, i) => [
  i & 1,
  (i >> 1) & 1,
  (i >> 2) & 1,
]);
const positions = corners.flat();
const tets = [
  [0, 1, 3, 7],
  [0, 3, 2, 7],
  [0, 2, 6, 7],
  [0, 6, 4, 7],
  [0, 4, 5, 7],
  [0, 5, 1, 7],
].flat();
const field = ([x, y, z]) => x + 2 * y + 3 * z;
const values = corners.map(field);
// Its boundary: two triangles per face.
const quads = [
  [0, 2, 3, 1],
  [4, 5, 7, 6],
  [0, 1, 5, 4],
  [2, 6, 7, 3],
  [0, 4, 6, 2],
  [1, 3, 7, 5],
];
const triangles = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);

function area(mesh) {
  let total = 0;
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) =>
      mesh.positions.slice(
        3 * mesh.triangles[t + k],
        3 * mesh.triangles[t + k] + 3,
      ),
    );
    const ab = [0, 1, 2].map((k) => b[k] - a[k]);
    const ac = [0, 1, 2].map((k) => c[k] - a[k]);
    total +=
      Math.hypot(
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ) / 2;
  }
  return total;
}

const pointsOf = (mesh) =>
  Array.from({ length: mesh.positions.length / 3 }, (_, i) =>
    mesh.positions.slice(3 * i, 3 * i + 3),
  );

describe("cutTets", () => {
  test.each([0, 1, 2])(
    "a cut normal to axis %i is the cube's whole cross-section",
    (axis) => {
      const cap = cutTets({ positions, tets, values }, axis, 0.3);
      expect(area(cap)).toBeCloseTo(1, 12);
      for (const point of pointsOf(cap)) expect(point[axis]).toBeCloseTo(0.3);
    },
  );

  test("the cap carries the field interpolated along the cut edges", () => {
    const cap = cutTets({ positions, tets, values }, 2, 0.25);
    pointsOf(cap).forEach((point, i) =>
      expect(cap.values[i]).toBeCloseTo(field(point), 12),
    );
  });

  test("every cap triangle faces along the axis, so it shades evenly", () => {
    for (const axis of [0, 1, 2]) {
      const cap = cutTets({ positions, tets, values }, axis, 0.4);
      for (let t = 0; t < cap.triangles.length; t += 3) {
        const [a, b, c] = [0, 1, 2].map((k) =>
          cap.positions.slice(
            3 * cap.triangles[t + k],
            3 * cap.triangles[t + k] + 3,
          ),
        );
        const ab = [0, 1, 2].map((k) => b[k] - a[k]);
        const ac = [0, 1, 2].map((k) => c[k] - a[k]);
        const normal = [
          ab[1] * ac[2] - ab[2] * ac[1],
          ab[2] * ac[0] - ab[0] * ac[2],
          ab[0] * ac[1] - ab[1] * ac[0],
        ];
        expect(normal[axis]).toBeGreaterThan(0);
      }
    }
  });

  test("a plane that misses the model cuts nothing", () => {
    const cap = cutTets({ positions, tets, values }, 0, 1.5);
    expect(cap.triangles).toHaveLength(0);
  });
});

describe("clipSurface", () => {
  test("keeps the boundary below the plane, split where it crosses", () => {
    const clipped = clipSurface({ positions, values, triangles }, 2, 0.5);
    // The bottom face and the lower half of the four sides.
    expect(area(clipped)).toBeCloseTo(3, 12);
    for (const point of pointsOf(clipped))
      expect(point[2]).toBeLessThanOrEqual(0.5 + 1e-12);
    pointsOf(clipped).forEach((point, i) =>
      expect(clipped.values[i]).toBeCloseTo(field(point), 12),
    );
  });

  test("keeps everything below a plane above the model", () => {
    const clipped = clipSurface({ positions, values, triangles }, 1, 2);
    expect(area(clipped)).toBeCloseTo(6, 12);
  });
});

describe("sectionMesh", () => {
  test("the clipped boundary and the cap close the lower part", () => {
    const mesh = sectionMesh({ positions, values, triangles, tets }, 0, 0.5);
    // Lower half of the cube: cap 1, x = 0 face 1, four half faces 0.5 each.
    expect(area(mesh)).toBeCloseTo(4, 12);
  });

  test("refuses an axis other than 0, 1 or 2", () => {
    expect(() =>
      sectionMesh({ positions, values, triangles, tets }, 3, 0.5),
    ).toThrow("axis");
  });
});

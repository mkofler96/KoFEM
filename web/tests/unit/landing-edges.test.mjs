// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the landing page's CAD-edge extraction (scripts/landing-edges.mjs):
// reading the triangulated face of a tessellated STEP and keeping only the
// sharp edges, so fillets stay unlined.

import { describe, expect, test } from "bun:test";
import {
  parseTriangulatedStep,
  sharpEdges,
} from "../../scripts/landing-edges.mjs";

const unitSquareStep = `ISO-10303-21;
DATA;
#27=COMPLEX_TRIANGULATED_FACE('Body',#28,4,((0.,0.,1.),(0.,0.,1.),(0.,0.,1.),
(0.,0.,1.)),$,(1,2,3,4),((1,2,3),(3,2,4)),());
#28=COORDINATES_LIST('',4,((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(1.,1.,0.)));
ENDSEC;
END-ISO-10303-21;`;

// A unit cube: 8 corners, 12 triangles, outward winding.
const cubePoints = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const cubeTriangles = [
  [0, 2, 1],
  [0, 3, 2],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [1, 2, 6],
  [1, 6, 5],
  [2, 3, 7],
  [2, 7, 6],
  [3, 0, 4],
  [3, 4, 7],
];

describe("parseTriangulatedStep", () => {
  test("reads the coordinates and the strip triangles through pnindex", () => {
    const { points, triangles } = parseTriangulatedStep(unitSquareStep);
    expect(points).toEqual([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ]);
    expect(triangles).toEqual([
      [0, 1, 2],
      [2, 1, 3],
    ]);
  });

  test("refuses a STEP without a triangulated face", () => {
    expect(() =>
      parseTriangulatedStep("ISO-10303-21;\nDATA;\nENDSEC;"),
    ).toThrow(/COMPLEX_TRIANGULATED_FACE/);
  });
});

describe("sharpEdges", () => {
  test("keeps a cube's 12 edges and drops its 6 face diagonals", () => {
    const segments = sharpEdges(cubePoints, cubeTriangles, 20);
    expect(segments.length).toBe(12);
    for (const [a, b] of segments) {
      const differing = a.filter((value, axis) => value !== b[axis]).length;
      expect(differing).toBe(1);
    }
  });

  test("refuses an open surface, which has no dihedral at its border", () => {
    expect(() => sharpEdges(cubePoints, cubeTriangles.slice(1), 20)).toThrow(
      /not closed/,
    );
  });
});

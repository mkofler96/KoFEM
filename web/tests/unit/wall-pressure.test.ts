// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A pressure on a face that a curved thin wall collapsed (KOF-448) loads that
// wall's shell facets directly, scaled to the loaded face's area, instead of
// moving each solid node's share onto the nearest shell node: on a thin tube
// the nearest-node shares are uneven enough to ovalise it.

import { expect, test } from "bun:test";
import type { ShellExtraction } from "../../src/lib/shellize";
import { curvedWallPressures } from "../../src/lib/solve/wallPressure";
import type { SurfaceLoad } from "../../src/workers/solverTypes";

// One curved wall: kept face 1 (z = 1, 1 × 1 mm), partner face 2 (z = 0,
// 1.1 × 1.1 mm), collapsed to a 1 × 1 mm square at z = 0.5 wound along the
// kept face's outward normal (+z). Face 3 is a planar wall's face.
const nodes: Record<number, [number, number, number]> = {
  1: [0, 0, 1],
  2: [1, 0, 1],
  3: [1, 1, 1],
  4: [0, 1, 1],
  5: [0, 0, 0],
  6: [1.1, 0, 0],
  7: [1.1, 1.1, 0],
  8: [0, 1.1, 0],
  9: [5, 0, 0],
  10: [6, 0, 0],
  11: [5, 1, 0],
};
const position = (id: number): [number, number, number] => nodes[id];
// Every face wound outward from the material.
const surface = {
  triangles: [
    [1, 2, 3],
    [1, 3, 4],
    [5, 7, 6],
    [5, 8, 7],
    [9, 10, 11],
  ] as [number, number, number][],
  faceIds: [1, 1, 2, 2, 3],
};
const shells: ShellExtraction = {
  walls: [
    { keep: 1, n: [0, 0, 1], thk: 1, body: 1, curved: true, partner: 2 },
    { keep: 3, n: [0, 0, -1], thk: 1, body: 1, curved: false, partner: 4 },
  ],
  shellBody: 1,
  shellVerts: [0, 0, 0.5, 1, 0, 0.5, 1, 1, 0.5, 0, 1, 0.5],
  shellTris: [0, 1, 2, 0, 2, 3],
  shellThk: [1, 1],
  shellSrc: [1, 1, 1, 1],
  shellTriSrc: [1, 1],
};

const pressure = (faces: number[][], value = 2): SurfaceLoad => ({
  type: "pressure",
  faces,
  pressure: value,
});

const total = (forces: Map<number, [number, number, number]>) =>
  [...forces.values()].reduce(
    (sum, force) => sum.map((value, axis) => value + force[axis]),
    [0, 0, 0],
  );

test("a pressure on the partner face pushes the facets towards the kept face, with the face's force", () => {
  const split = curvedWallPressures(
    [pressure(surface.triangles.slice(2, 4))],
    shells,
    surface,
    position,
  );
  expect(split.remaining).toEqual([]);
  const [fx, fy, fz] = total(split.shellForces);
  expect(Math.abs(fx) + Math.abs(fy)).toBeLessThan(1e-12);
  // p · A = 2 · 1.21 along +z (into the wall from the partner side).
  expect(fz).toBeCloseTo(2.42, 12);
  expect([...split.shellForces.keys()].sort()).toEqual([0, 1, 2, 3]);
});

test("a pressure on the kept face pushes the facets towards the partner", () => {
  const split = curvedWallPressures(
    [pressure(surface.triangles.slice(0, 2))],
    shells,
    surface,
    position,
  );
  expect(split.remaining).toEqual([]);
  expect(total(split.shellForces)[2]).toBeCloseTo(-2, 12);
});

test("part of a curved wall's face, a planar wall's face and a force stay with the solid faces", () => {
  const partial = pressure([surface.triangles[2]]);
  const planar = pressure([surface.triangles[4]]);
  const force: SurfaceLoad = {
    type: "force",
    faces: surface.triangles.slice(2, 4),
    force: [0, 0, 1],
  };
  const split = curvedWallPressures(
    [partial, planar, force],
    shells,
    surface,
    position,
  );
  expect(split.remaining).toEqual([partial, planar, force]);
  expect(split.shellForces.size).toBe(0);
});

test("one load over a curved wall's face and another face splits between them", () => {
  const split = curvedWallPressures(
    [pressure([...surface.triangles.slice(0, 2), surface.triangles[4]])],
    shells,
    surface,
    position,
  );
  expect(split.remaining).toEqual([pressure([surface.triangles[4]])]);
  expect(total(split.shellForces)[2]).toBeCloseTo(-2, 12);
});

test("a loaded triangle on no CAD face stays with the solid faces", () => {
  const stray = pressure([[1, 2, 9]]);
  const split = curvedWallPressures([stray], shells, surface, position);
  expect(split.remaining).toEqual([stray]);
  expect(split.shellForces.size).toBe(0);
});

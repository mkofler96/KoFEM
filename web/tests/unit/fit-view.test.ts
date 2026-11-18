// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Fit view frames what the viewport draws (KOF-385): with a deformed result
// shown, the deformed shape at the scale the scene draws it with, and the
// undeformed overlay when that is visible. Without a result, or at scale 0,
// the undeformed model and the CAD tessellation as before.

import { expect, test } from "bun:test";
import { fitViewBox } from "../../src/lib/fitView";

// A 10 mm bar along x whose tip node moves 4 mm down in y.
const nodes = [
  { x: 0, y: 0, z: 0 },
  { x: 10, y: 0, z: 0 },
  { x: 10, y: 1, z: 1 },
];
const displacements = new Float64Array([0, 0, 0, 0, -4, 0, 0, -4, 0]);
const stepSurface = {
  points: [
    [0, 0, 0],
    [10, 2, 1],
  ] as [number, number, number][],
};

test("without a result, Fit view frames the nodes and the CAD tessellation", () => {
  expect(fitViewBox({ nodes, stepSurface, deformed: null })).toEqual({
    min: [0, 0, 0],
    max: [10, 2, 1],
  });
});

test("at scale 0, Fit view frames what it frames without a result", () => {
  const box = fitViewBox({
    nodes,
    stepSurface,
    deformed: { displacements, scale: 0, showUndeformed: false },
  });
  expect(box).toEqual({ min: [0, 0, 0], max: [10, 2, 1] });
});

test("with a deformed result and the undeformed overlay, Fit view frames both", () => {
  const box = fitViewBox({
    nodes,
    stepSurface,
    deformed: { displacements, scale: 2, showUndeformed: true },
  });
  // The tip moves 8 mm down; the undeformed nodes reach y = 1.
  expect(box).toEqual({ min: [0, -8, 0], max: [10, 1, 1] });
});

test("with the undeformed overlay hidden, Fit view frames the deformed shape alone", () => {
  const box = fitViewBox({
    nodes,
    stepSurface,
    deformed: { displacements, scale: 2, showUndeformed: false },
  });
  expect(box).toEqual({ min: [0, -8, 0], max: [10, 0, 1] });
});

test("an empty model has nothing to frame", () => {
  expect(fitViewBox({ nodes: [], stepSurface: null, deformed: null })).toBe(
    null,
  );
});

test("a displacement field that does not match the nodes is an error", () => {
  expect(() =>
    fitViewBox({
      nodes,
      stepSurface: null,
      deformed: {
        displacements: new Float64Array(3),
        scale: 1,
        showUndeformed: true,
      },
    }),
  ).toThrow(/3 nodes/);
});

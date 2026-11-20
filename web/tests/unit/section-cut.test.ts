// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The wiring of the section plane (KOF-390) around the Rust cut: the model as
// drawn (deformed), where the slider puts the plane, and the clipping plane
// that hides the removed part of the drawn surface. The cut itself is tested
// in crates/kofem-fem/tests/section.rs and integration/section-cut.test.mjs.

import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  deformedPoints,
  sectionClipPlane,
  sectionLevel,
} from "../../src/lib/sectionCut";

const nodes = [
  { id: 1, x: 0, y: 0, z: 0 },
  { id: 2, x: 10, y: 0, z: 0 },
  { id: 3, x: 0, y: 4, z: 0 },
];
const displacements = Float64Array.from([0, 0, 0, 1, 0, 0, 0, 0, 0.5]);

describe("the section plane's position", () => {
  test("follows the model as drawn, deformation scale included", () => {
    expect([...deformedPoints(nodes, displacements, 2)]).toEqual([
      0, 0, 0, 12, 0, 0, 0, 4, 1,
    ]);
  });

  test("spans the drawn extent along its axis", () => {
    const points = deformedPoints(nodes, displacements, 2);
    expect(sectionLevel(points, 0, 0)).toBe(0);
    expect(sectionLevel(points, 0, 0.25)).toBe(3);
    expect(sectionLevel(points, 1, 1)).toBe(4);
  });
});

describe("the clipping plane", () => {
  const keeps = (plane: THREE.Plane, point: [number, number, number]) =>
    plane.distanceToPoint(new THREE.Vector3(...point)) >= 0;

  test("keeps the part below the plane", () => {
    const plane = sectionClipPlane(2, 5, false);
    expect(keeps(plane, [0, 0, 4])).toBe(true);
    expect(keeps(plane, [0, 0, 6])).toBe(false);
  });

  test("keeps the part above it when flipped", () => {
    const plane = sectionClipPlane(0, -1, true);
    expect(keeps(plane, [0, 9, 9])).toBe(true);
    expect(keeps(plane, [-2, 0, 0])).toBe(false);
  });
});

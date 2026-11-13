// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit tests for src/lib/meshSizing.ts — the default element size a fresh
// import starts from (KOF-222). The old fixed 20 mm default (and the 0.5 mm
// floor on the input) made small parts unmeshable: on a 1x1x1 mm cube every
// legal setting was coarser than the part itself.
//
// The estimator's coefficients were calibrated against Netgen on the parts in
// test_files/; these tests pin the properties that calibration relies on —
// exact measurement of a closed tessellation, scale invariance, and hitting the
// target count — without needing the WASM engine.

import { describe, expect, test } from "bun:test";
import {
  measureTessellation,
  estimateElementCount,
  sizeFromMeasure,
  suggestElementSizes,
  TARGET_ELEMENT_COUNT,
  MIN_SIZE_RATIO,
} from "../../src/lib/meshSizing.ts";

// Axis-aligned box tessellation with outward-facing triangles, side lengths
// sx/sy/sz — volume sx·sy·sz and area 2(sx·sy + sy·sz + sz·sx) exactly.
function box(sx, sy, sz) {
  const points = [
    [0, 0, 0],
    [sx, 0, 0],
    [sx, sy, 0],
    [0, sy, 0],
    [0, 0, sz],
    [sx, 0, sz],
    [sx, sy, sz],
    [0, sy, sz],
  ];
  const triangles = [
    [0, 2, 1],
    [0, 3, 2], // z = 0
    [4, 5, 6],
    [4, 6, 7], // z = sz
    [0, 1, 5],
    [0, 5, 4], // y = 0
    [3, 7, 6],
    [3, 6, 2], // y = sy
    [0, 4, 7],
    [0, 7, 3], // x = 0
    [1, 2, 6],
    [1, 6, 5], // x = sx
  ];
  return { points, triangles };
}

describe("measuring a closed tessellation", () => {
  const { points, triangles } = box(2, 3, 4);
  const measure = measureTessellation(points, triangles);

  test("volume is exact", () => {
    expect(Math.abs(measure.volume - 24)).toBeLessThan(1e-9);
  });

  test("area is exact", () => {
    expect(Math.abs(measure.area - 52)).toBeLessThan(1e-9);
  });

  test("bounding box is exact", () => {
    expect(measure.dx).toBe(2);
    expect(measure.dy).toBe(3);
    expect(measure.dz).toBe(4);
  });
});

describe("empty geometry has no measure", () => {
  test("no points", () => {
    expect(measureTessellation([], [])).toBeNull();
  });

  test("no triangles", () => {
    expect(measureTessellation([[0, 0, 0]], [])).toBeNull();
  });
});

describe("the suggested size hits the target element count", () => {
  test.each([
    [[1, 1, 1]],
    [[40, 40, 60]],
    [[300, 80, 80]],
    [[1000, 20, 2]], // long thin strip: the area term dominates
  ])("%j mm box", (dims) => {
    const { points, triangles } = box(...dims);
    const measure = measureTessellation(points, triangles);
    const size = sizeFromMeasure(measure);
    const count = estimateElementCount(measure, size);
    expect(
      Math.abs(count - TARGET_ELEMENT_COUNT) / TARGET_ELEMENT_COUNT,
      `estimated ${Math.round(count)} elements, target ${TARGET_ELEMENT_COUNT}, size ${size.toPrecision(3)} mm`,
    ).toBeLessThan(1e-3);
  });
});

describe("KOF-222: a 1 mm cube is sized far below the old 0.5 mm floor", () => {
  const { points, triangles } = box(1, 1, 1);
  const suggestion = suggestElementSizes(points, triangles);
  const maxSize = parseFloat(suggestion.max);
  const minSize = parseFloat(suggestion.min);

  test("max size is well under 0.5 mm", () => {
    expect(maxSize, `${suggestion.max} mm`).toBeLessThan(0.1);
  });

  test("the cube spans at least 10 elements per side", () => {
    expect(1 / maxSize, `${suggestion.max} mm`).toBeGreaterThanOrEqual(10);
  });

  test(`min size is max/${MIN_SIZE_RATIO}`, () => {
    expect(
      Math.abs(minSize - maxSize / MIN_SIZE_RATIO),
      `${suggestion.min} mm vs ${maxSize / MIN_SIZE_RATIO}`,
    ).toBeLessThan(maxSize / MIN_SIZE_RATIO / 100);
  });

  test("sizes are rounded for display, not raw solver output", () => {
    expect(suggestion.max).toMatch(/^\d*\.?\d+$/);
    expect(suggestion.max.length).toBeLessThanOrEqual(6);
  });
});

describe("sizing is scale invariant", () => {
  const sizeOf = (sx, sy, sz) => {
    const { points, triangles } = box(sx, sy, sz);
    return sizeFromMeasure(measureTessellation(points, triangles));
  };

  // Volume and area terms scale differently, so the ratio is not exactly 1000;
  // it must still track the model's scale rather than sitting at a constant.
  test("a 1000x larger cube gets a much larger element size", () => {
    const small = sizeOf(1, 1, 1);
    const large = sizeOf(1000, 1000, 1000);
    expect(
      large / small,
      `${small.toPrecision(3)} mm vs ${large.toPrecision(3)} mm`,
    ).toBeGreaterThan(100);
  });
});

describe("open (surface-only) geometry is sized from its area alone", () => {
  const points = [
    [0, 0, 0],
    [100, 0, 0],
    [100, 100, 0],
  ];
  const measure = measureTessellation(points, [[0, 1, 2]]);
  const size = sizeFromMeasure(measure);

  test("a flat sheet encloses no volume", () => {
    expect(measure.volume).toBeLessThan(1e-9);
  });

  test("it still gets a size", () => {
    expect(size).not.toBeNull();
    expect(size).toBeGreaterThan(0);
  });

  test("sized to the target from the area term", () => {
    expect(
      Math.abs(estimateElementCount(measure, size) - TARGET_ELEMENT_COUNT) /
        TARGET_ELEMENT_COUNT,
    ).toBeLessThan(1e-3);
  });
});

describe("a degenerate tessellation reports the bad index, not a silent NaN", () => {
  const degenerate = () => measureTessellation([[0, 0, 0]], [[0, 1, 2]]);

  test("out-of-range vertex throws", () => {
    expect(degenerate).toThrow();
  });

  test("the message names the triangle", () => {
    expect(degenerate).toThrow(/\(0, 1, 2\)/);
  });
});

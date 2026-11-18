// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Unit test for the mesh refinement chart's layout (src/lib/refinementChart.ts,
// KOF-401): where each level lands, and the band the verdict is judged by.

import { describe, expect, test } from "bun:test";
import { chartLayout, type ChartBox } from "../../src/lib/refinementChart";
import {
  CONVERGED_TOLERANCE,
  levelSizes,
  REFINEMENT_RATIO,
  type StudyLevel,
} from "../../src/lib/refinementStudy";

const box: ChartBox = { left: 50, right: 450, top: 20, bottom: 220 };
const base = { max: 8, min: 0.8, regions: {} };

function level(
  k: number,
  elements: number,
  maxDisplacement: number,
  maxVonMises: number | null = 100,
): StudyLevel {
  return {
    sizes: levelSizes(base, k),
    nodes: elements / 5,
    elements,
    maxDisplacement,
    maxVonMises,
  };
}

describe("chartLayout", () => {
  test("no levels yet: nothing to draw", () => {
    const layout = chartLayout([], "displacement", box);
    expect(layout.points).toEqual([]);
    expect(layout.band).toBeNull();
  });

  test("one level sits in the middle of the plot", () => {
    const layout = chartLayout([level(0, 1000, 1.0)], "displacement", box);
    expect(layout.points[0].x).toBeCloseTo(250, 9);
    expect(layout.points[0].y).toBeCloseTo(120, 9);
  });

  // The element count grows geometrically, so the axis is logarithmic: the
  // middle level of three, at the geometric mean, lands in the middle.
  test("the element axis is logarithmic", () => {
    const layout = chartLayout(
      [level(0, 1000, 1.0), level(1, 4000, 1.1), level(2, 16000, 1.12)],
      "displacement",
      box,
    );
    const [first, middle, last] = layout.points.map((p) => p.x);
    expect(first).toBeLessThan(middle);
    expect(middle - first).toBeCloseTo(last - middle, 9);
  });

  test("a larger value sits higher", () => {
    const layout = chartLayout(
      [level(0, 1000, 1.0), level(1, 4000, 1.1)],
      "displacement",
      box,
    );
    expect(layout.points[1].y).toBeLessThan(layout.points[0].y);
  });

  // f(h) = f∞ − C·h², three levels: Richardson recovers f∞ = 2, and the band
  // is the verdict's ±2 % around it.
  test("the displacement band is ±2 % of the extrapolated value", () => {
    const disp = (k: number) => 2 - 0.5 * (1 / REFINEMENT_RATIO ** k) ** 2;
    const layout = chartLayout(
      [
        level(0, 1000, disp(0)),
        level(1, 2800, disp(1)),
        level(2, 8000, disp(2)),
      ],
      "displacement",
      box,
    );
    expect(layout.reference).toBeCloseTo(2, 9);
    expect(layout.extrapolated).toBe(true);
    expect(layout.band).not.toBeNull();
    expect(layout.band?.low).toBeCloseTo(2 * (1 - CONVERGED_TOLERANCE), 9);
    expect(layout.band?.high).toBeCloseTo(2 * (1 + CONVERGED_TOLERANCE), 9);
    // Every point and the band fit in the plot.
    for (const p of layout.points) {
      expect(p.y).toBeGreaterThanOrEqual(box.top);
      expect(p.y).toBeLessThanOrEqual(box.bottom);
    }
    expect(layout.bandY?.top).toBeGreaterThanOrEqual(box.top);
    expect(layout.bandY?.bottom).toBeLessThanOrEqual(box.bottom);
  });

  test("without an extrapolation the band sits around the finest level", () => {
    const layout = chartLayout(
      [level(0, 1000, 1.0), level(1, 2800, 1.1)],
      "displacement",
      box,
    );
    expect(layout.extrapolated).toBe(false);
    expect(layout.reference).toBeCloseTo(1.1, 9);
  });

  test("the stress view has no band: the verdict is on displacement", () => {
    const layout = chartLayout(
      [level(0, 1000, 1.0, 50), level(1, 2800, 1.1, 60)],
      "stress",
      box,
    );
    expect(layout.band).toBeNull();
    expect(layout.points.map((p) => p.value)).toEqual([50, 60]);
  });

  test("a level without stress has no point in the stress view", () => {
    const layout = chartLayout(
      [level(0, 1000, 1.0, null), level(1, 2800, 1.1, null)],
      "stress",
      box,
    );
    expect(layout.points).toEqual([]);
  });
});

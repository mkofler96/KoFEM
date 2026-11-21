// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The topology optimization's convergence chart, drawn in the centre in place
// of the 3D view like the mesh refinement study's: one field against the
// iteration, with the constraint's bound as a line. The layout is pure, so the
// component only draws.

import { describe, expect, test } from "bun:test";
import {
  chartAxis,
  chartBound,
  chartFields,
  chartStatus,
  topOptChartLayout,
  type TopOptChartBox,
} from "../../src/lib/topOptChart";
import { DEFAULT_TOPOPT_SETTINGS } from "../../src/store/topOptSlice";
import type { ConvergencePoint } from "../../src/lib/topOptProgress";

const BOX: TopOptChartBox = { left: 100, right: 500, top: 50, bottom: 250 };

const history: ConvergencePoint[] = [
  { it: 1, compliance: 100, volume: 0.5 },
  { it: 2, compliance: 80, volume: 0.48 },
  { it: 3, compliance: 70, volume: 0.45 },
];

const stressed: ConvergencePoint[] = [
  { it: 1, compliance: 100, volume: 0.5, stress: 900, maxStress: 1000 },
  { it: 2, compliance: 90, volume: 0.5, stress: 700, maxStress: 820 },
];

describe("chartFields", () => {
  test("compliance and volume always, stress only when the run bounds it", () => {
    expect(chartFields(history)).toEqual(["compliance", "volume"]);
    expect(chartFields(stressed)).toEqual(["compliance", "volume", "stress"]);
  });
});

describe("topOptChartLayout", () => {
  test("puts the first iteration on the left edge and the last on the right", () => {
    const layout = topOptChartLayout(history, "compliance", BOX, null);
    const [line] = layout.series;
    expect(line.points.map((p) => p.x)).toEqual([100, 300, 500]);
    expect(line.points.map((p) => p.it)).toEqual([1, 2, 3]);
  });

  test("puts the largest value at the top and the smallest at the bottom", () => {
    const layout = topOptChartLayout(history, "compliance", BOX, null);
    const ys = layout.series[0].points.map((p) => p.y);
    expect(ys[0]).toBe(BOX.top);
    expect(ys[2]).toBe(BOX.bottom);
    expect(layout.range).toEqual({ min: 70, max: 100 });
  });

  test("widens the range to take in the constraint's bound, and draws it", () => {
    const layout = topOptChartLayout(history, "volume", BOX, 0.4);
    expect(layout.range).toEqual({ min: 0.4, max: 0.5 });
    expect(layout.boundY).toBe(BOX.bottom);
  });

  test("a stress run draws the aggregate and the true maximum it tracks", () => {
    const layout = topOptChartLayout(stressed, "stress", BOX, 800);
    expect(layout.series.map((s) => s.kind)).toEqual(["value", "maxStress"]);
    expect(layout.series[1].points.map((p) => p.value)).toEqual([1000, 820]);
    expect(layout.range).toEqual({ min: 700, max: 1000 });
  });

  test("a single iteration sits in the middle of a flat range", () => {
    const layout = topOptChartLayout([history[0]], "compliance", BOX, null);
    const [point] = layout.series[0].points;
    expect(point.x).toBe(300);
    expect(point.y).toBe(150);
  });

  test("without points there is nothing to draw", () => {
    const layout = topOptChartLayout([], "compliance", BOX, null);
    expect(layout.series).toEqual([]);
    expect(layout.range).toBeNull();
    expect(layout.boundY).toBeNull();
  });

  test("asking for stress on a run without it is an error", () => {
    expect(() => topOptChartLayout(history, "stress", BOX, null)).toThrow(
      "stress",
    );
  });
});

describe("chartBound", () => {
  const settings = { ...DEFAULT_TOPOPT_SETTINGS, volumeFraction: "0.4" };

  test("minimum compliance bounds the volume by its target", () => {
    expect(chartBound("volume", settings)).toEqual({
      name: "Target",
      value: 0.4,
    });
    expect(chartBound("compliance", settings)).toBeNull();
  });

  test("minimum volume bounds the compliance by its limit, when one is set", () => {
    const minVolume = {
      ...settings,
      objective: "min_volume" as const,
      complianceLimit: "12",
    };
    expect(chartBound("compliance", minVolume)).toEqual({
      name: "Limit",
      value: 12,
    });
    expect(chartBound("volume", minVolume)).toBeNull();
    expect(
      chartBound("compliance", { ...minVolume, complianceLimit: "" }),
    ).toBeNull();
  });

  test("a SIMP stress limit bounds the stress; the level set has none", () => {
    const stressed = { ...settings, stressConstraint: true, maxStress: "250" };
    expect(chartBound("stress", stressed)).toEqual({
      name: "σ_allow",
      value: 250,
    });
    expect(
      chartBound("stress", { ...stressed, method: "level_set" as const }),
    ).toBeNull();
  });
});

describe("chartStatus", () => {
  test("a running run counts its iterations against the limit", () => {
    expect(chartStatus(true, null, "50", null)).toBe("Optimizing · starting");
    expect(chartStatus(true, 12, "50", null)).toBe(
      "Optimizing · iteration 12 of 50",
    );
  });

  test("a finished run gives its verdict", () => {
    expect(
      chartStatus(false, 9, "50", { converged: true, iterations: 9 }),
    ).toBe("Converged after 9 iterations");
    expect(
      chartStatus(false, 50, "50", { converged: false, iterations: 50 }),
    ).toBe("Not converged: stopped at the 50-iteration limit");
  });

  test("no run, no status", () => {
    expect(chartStatus(false, null, "50", null)).toBeNull();
  });
});

describe("chartAxis", () => {
  test("names each field's axis, the stress with its unit", () => {
    expect(chartAxis("compliance", "MPa")).toBe("Compliance");
    expect(chartAxis("volume", "MPa")).toBe("Volume fraction");
    expect(chartAxis("stress", "MPa")).toBe("Von Mises stress (MPa)");
  });
});

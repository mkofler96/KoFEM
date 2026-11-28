// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The report's charts (KOF-391): scientific-plot style with a closed frame,
// inward major and minor ticks on all sides and no grid.

import { expect, test } from "bun:test";
import {
  linearTicks,
  logTicks,
  niceStep,
  scientificChart,
} from "../../src/lib/report/chart";

test("tick steps are 1, 2 or 5 times a power of ten", () => {
  expect(niceStep(167, 5)).toBe(50);
  expect(niceStep(1, 5)).toBe(0.2);
  expect(niceStep(9, 4)).toBe(2);
});

test("linear ticks: majors on the step, minors between", () => {
  const ticks = linearTicks(38, 205, 5);
  expect(ticks.major).toEqual([50, 100, 150, 200]);
  expect(ticks.minor).toContain(40);
  expect(ticks.minor).toContain(60);
  expect(ticks.minor).not.toContain(50);
  expect(ticks.decimals).toBe(0);
});

test("log ticks: decades are majors, 2…9 times a decade minors", () => {
  const ticks = logTicks(2e4, 2e5);
  expect(ticks.major).toEqual([1e5]);
  expect(ticks.minor).toEqual([2e4, 3e4, 4e4, 5e4, 6e4, 7e4, 8e4, 9e4, 2e5]);
});

test("a chart is a framed SVG with one point per value and labels at the ends", () => {
  const svg = scientificChart({
    width: 330,
    height: 236,
    xs: [1, 2, 3, 4],
    ys: [192.5, 120, 60, 47.4],
    xScale: "linear",
    xRange: [0, 5],
    xLabel: "Iteration",
    yLabel: "Compliance in N mm",
    ends: [
      [0, "193", "right"],
      [3, "47.4", "left"],
    ],
  });
  expect(svg.startsWith('<svg class="chart')).toBe(true);
  expect(svg).toContain("<rect");
  expect(svg).toContain("rotate(-90)");
  expect(
    (svg.match(/<polyline[^>]*points="([^"]*)"/)?.[1] ?? "").trim().split(" "),
  ).toHaveLength(4);
  expect(svg).toContain(">193<");
  expect(svg).toContain(">47.4<");
  expect(svg).not.toContain("NaN");
});

test("a chart refuses values it cannot place", () => {
  expect(() =>
    scientificChart({
      width: 300,
      height: 200,
      xs: [1, 2],
      ys: [1],
      xScale: "linear",
      xRange: [0, 3],
      xLabel: "",
      yLabel: "",
    }),
  ).toThrow(/2 x values but 1 y values/);
  expect(() =>
    scientificChart({
      width: 300,
      height: 200,
      xs: [0, 10],
      ys: [1, 2],
      xScale: "log",
      xRange: [0, 100],
      xLabel: "",
      yLabel: "",
    }),
  ).toThrow(/log/);
});

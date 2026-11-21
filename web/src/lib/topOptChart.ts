// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Layout of the topology optimization's convergence chart, drawn in the centre
// in place of the 3D view like the mesh refinement study's (refinementChart.ts):
// one field against the iteration, on its own value axis, with the bound of
// the constraint on that field as a line. Pure, so the component only draws.

import type { ConvergencePoint } from "./topOptProgress";

export type TopOptChartField = "compliance" | "volume" | "stress";

// The plot area inside the SVG, in its units.
export interface TopOptChartBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface TopOptChartPoint {
  x: number;
  y: number;
  it: number;
  value: number;
}

// "value" is the field itself; a stress run adds "maxStress", the true peak
// von Mises stress the aggregated constraint value tracks.
export interface TopOptChartSeries {
  kind: "value" | "maxStress";
  points: TopOptChartPoint[];
}

export interface TopOptChartLayout {
  series: TopOptChartSeries[];
  // The value range the y axis spans, bound included; null without points.
  range: { min: number; max: number } | null;
  // Where the constraint's bound is drawn; null without one.
  boundY: number | null;
}

// The fields a run's history can show: stress only when the run bounded it.
export function chartFields(points: ConvergencePoint[]): TopOptChartField[] {
  const stressed =
    points.length > 0 &&
    points.every((p) => p.stress !== undefined && p.maxStress !== undefined);
  return stressed
    ? ["compliance", "volume", "stress"]
    : ["compliance", "volume"];
}

function seriesValues(
  points: ConvergencePoint[],
  field: TopOptChartField,
): { kind: TopOptChartSeries["kind"]; values: number[] }[] {
  if (field === "compliance")
    return [{ kind: "value", values: points.map((p) => p.compliance) }];
  if (field === "volume")
    return [{ kind: "value", values: points.map((p) => p.volume) }];
  const stress = points.map((p) => p.stress);
  const peak = points.map((p) => p.maxStress);
  if (stress.some((v) => v === undefined) || peak.some((v) => v === undefined))
    throw new Error(
      "topOptChartLayout: the run carries no stress history — chart the stress only for a stress-constrained run",
    );
  return [
    { kind: "value", values: stress as number[] },
    { kind: "maxStress", values: peak as number[] },
  ];
}

export function topOptChartLayout(
  points: ConvergencePoint[],
  field: TopOptChartField,
  box: TopOptChartBox,
  bound: number | null,
): TopOptChartLayout {
  if (points.length === 0) return { series: [], range: null, boundY: null };
  const series = seriesValues(points, field);
  const all = series.flatMap((line) => line.values);
  if (bound !== null) all.push(bound);
  const min = Math.min(...all);
  const max = Math.max(...all);

  const first = points[0].it;
  const last = points[points.length - 1].it;
  const xOf = (it: number) =>
    last > first
      ? box.left + ((it - first) / (last - first)) * (box.right - box.left)
      : (box.left + box.right) / 2;
  // A flat range (one iteration, or a field that never moved) sits in the
  // middle rather than divide by zero.
  const yOf = (value: number) =>
    max > min
      ? box.top + ((max - value) / (max - min)) * (box.bottom - box.top)
      : (box.top + box.bottom) / 2;

  return {
    series: series.map(({ kind, values }) => ({
      kind,
      points: values.map((value, i) => ({
        x: xOf(points[i].it),
        y: yOf(value),
        it: points[i].it,
        value,
      })),
    })),
    range: { min, max },
    boundY: bound === null ? null : yOf(bound),
  };
}

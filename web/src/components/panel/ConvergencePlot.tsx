// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Convergence history for a topology-optimization run (KOF-233): objective
// (compliance) and volume fraction vs iteration, as a lightweight inline SVG —
// no charting dependency. Drives both the live curve in the Optimize panel
// (parsed from streamed logs) and the final curve in Results (from the returned
// history); both reduce to ConvergencePoint[].

import type { ConvergencePoint } from "../../lib/topOptProgress";

const PLOT_W = 300;
const PLOT_H = 150;
const PAD_LEFT = 8;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 20;

const OBJ_COLOR = "#4e79a7"; // objective (compliance) — normalized to its range
const VOL_COLOR = "#e15759"; // volume fraction — absolute 0..1

// Objective spans many orders of magnitude and volume fraction is bounded 0..1,
// so they cannot share a linear axis. The objective is normalized to its own
// [min, max] (its absolute start→end values are shown in the legend); volume
// fraction is drawn on an absolute 0..1 scale. Both then live in the same unit
// plot box, read against the legend rather than a shared numeric axis.
function pathFor(
  points: ConvergencePoint[],
  value: (point: ConvergencePoint) => number,
  valueMin: number,
  valueMax: number,
): string {
  const iterations = points.map((point) => point.it);
  const itMin = Math.min(...iterations);
  const itMax = Math.max(...iterations);
  // Zero span (a single iteration, or a flat series) collapses the axis; pin it
  // to the low end rather than divide by zero.
  const spanIt = itMax > itMin ? itMax - itMin : 1;
  const spanValue = valueMax > valueMin ? valueMax - valueMin : 1;
  const plotX = (it: number) =>
    PAD_LEFT + ((it - itMin) / spanIt) * (PLOT_W - PAD_LEFT - PAD_RIGHT);
  const plotY = (val: number) =>
    PAD_TOP +
    (1 - (val - valueMin) / spanValue) * (PLOT_H - PAD_TOP - PAD_BOTTOM);
  return points
    .map(
      (point, i) =>
        `${i === 0 ? "M" : "L"}${plotX(point.it).toFixed(1)} ${plotY(value(point)).toFixed(1)}`,
    )
    .join(" ");
}

export function ConvergencePlot({
  points,
  live = false,
}: {
  points: ConvergencePoint[];
  live?: boolean;
}) {
  if (points.length === 0) return null;

  const objectives = points.map((point) => point.objective);
  const objMin = Math.min(...objectives);
  const objMax = Math.max(...objectives);
  const objFirst = points[0].objective;
  const objLast = points[points.length - 1].objective;

  const objPath = pathFor(points, (point) => point.objective, objMin, objMax);
  const volPath = pathFor(points, (point) => point.volume, 0, 1);

  const fmt = (val: number) =>
    Math.abs(val) >= 1000 || (val !== 0 && Math.abs(val) < 0.01)
      ? val.toExponential(2)
      : val.toFixed(3);

  return (
    <div data-testid="convergence-plot" data-points={points.length}>
      <svg
        viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
        width="100%"
        role="img"
        aria-label="Convergence history: objective and volume fraction vs iteration"
        style={{ display: "block" }}
      >
        {/* plot frame */}
        <rect
          x={PAD_LEFT}
          y={PAD_TOP}
          width={PLOT_W - PAD_LEFT - PAD_RIGHT}
          height={PLOT_H - PAD_TOP - PAD_BOTTOM}
          fill="none"
          stroke="#d1d5db"
        />
        <path d={objPath} fill="none" stroke={OBJ_COLOR} strokeWidth={1.5} />
        <path d={volPath} fill="none" stroke={VOL_COLOR} strokeWidth={1.5} />
        <text x={PAD_LEFT} y={PLOT_H - 6} fontSize={9} fill="#6b7280">
          it {points[0].it}
        </text>
        <text
          x={PLOT_W - PAD_RIGHT}
          y={PLOT_H - 6}
          fontSize={9}
          fill="#6b7280"
          textAnchor="end"
        >
          it {points[points.length - 1].it}
          {live ? "…" : ""}
        </text>
      </svg>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 11 }}>
        <span style={{ color: OBJ_COLOR }}>
          ■ Objective {fmt(objFirst)} → {fmt(objLast)}
        </span>
        <span style={{ color: VOL_COLOR }}>
          ■ Volume fraction {points[points.length - 1].volume.toFixed(3)}
        </span>
      </div>
    </div>
  );
}

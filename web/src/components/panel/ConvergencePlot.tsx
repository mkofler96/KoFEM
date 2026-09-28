// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Convergence history for a topology-optimization run (KOF-233): compliance and
// volume fraction vs iteration — the objective/constraint pair of either
// formulation (KOF-235) — as a lightweight inline SVG, no charting dependency.
// A stress-constrained run (KOF-236) adds the aggregated stress the constraint
// bounds next to the true max von Mises stress it approximates, plus the σ_allow
// line, so the gap between the smooth aggregate and the real peak is visible. Drives both the live curve in the Optimize panel
// (parsed from streamed logs) and the final curve in Results (from the returned
// history); both reduce to ConvergencePoint[].

import type { ConvergencePoint } from "../../lib/topOptProgress";

const PLOT_W = 300;
const PLOT_H = 150;
const PAD_LEFT = 8;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 20;

const OBJ_COLOR = "#4e79a7"; // compliance — normalized to its range
const VOL_COLOR = "#e15759"; // volume fraction — absolute 0..1
const STRESS_COLOR = "#59a14f"; // aggregated stress — shared stress range
const MAX_STRESS_COLOR = "#f28e2b"; // true max stress — same range, dashed
const LIMIT_COLOR = "#9ca3af"; // σ_allow

interface Pt {
  x: number;
  y: number;
}

// Compliance spans many orders of magnitude and volume fraction is bounded 0..1,
// so they cannot share a linear axis. Compliance is normalized to its own
// [min, max] (its absolute start→end values are shown in the legend); volume
// fraction is drawn on an absolute 0..1 scale. Both then live in the same unit
// plot box, read against the legend rather than a shared numeric axis.
function scaledCoords(
  points: ConvergencePoint[],
  value: (point: ConvergencePoint) => number,
  valueMin: number,
  valueMax: number,
): Pt[] {
  const iterations = points.map((point) => point.it);
  const itMin = Math.min(...iterations);
  const itMax = Math.max(...iterations);
  // Zero span (a single iteration, or a flat series) collapses the axis; pin it
  // to the low end rather than divide by zero.
  const spanIt = itMax > itMin ? itMax - itMin : 1;
  const spanValue = valueMax > valueMin ? valueMax - valueMin : 1;
  return points.map((point) => ({
    x:
      PAD_LEFT +
      ((point.it - itMin) / spanIt) * (PLOT_W - PAD_LEFT - PAD_RIGHT),
    y:
      PAD_TOP +
      (1 - (value(point) - valueMin) / spanValue) *
        (PLOT_H - PAD_TOP - PAD_BOTTOM),
  }));
}

function toPath(coords: Pt[]): string {
  return coords
    .map(
      (pt, i) => `${i === 0 ? "M" : "L"}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`,
    )
    .join(" ");
}

export function ConvergencePlot({
  points,
  live = false,
  stressLimit = NaN,
}: {
  points: ConvergencePoint[];
  live?: boolean;
  // σ_allow of a stress-constrained run, drawn as a reference line; NaN = none.
  stressLimit?: number;
}) {
  if (points.length === 0) return null;

  const compliances = points.map((point) => point.compliance);
  const objMin = Math.min(...compliances);
  const objMax = Math.max(...compliances);
  const objFirst = points[0].compliance;
  const objLast = points[points.length - 1].compliance;

  const objCoords = scaledCoords(
    points,
    (point) => point.compliance,
    objMin,
    objMax,
  );
  const volCoords = scaledCoords(points, (point) => point.volume, 0, 1);

  // Stress series, when the run carried a stress constraint. The aggregate and
  // the true max share one range (with σ_allow) so their gap reads directly.
  const stressPoints = points.filter(
    (point) => point.stress !== undefined && point.maxStress !== undefined,
  );
  const hasStress = stressPoints.length > 0;
  const hasLimit = hasStress && Number.isFinite(stressLimit) && stressLimit > 0;
  const stressValues = stressPoints.flatMap((point) => [
    point.stress as number,
    point.maxStress as number,
  ]);
  if (hasLimit) stressValues.push(stressLimit);
  const stressMin = hasStress ? Math.min(...stressValues) : 0;
  const stressMax = hasStress ? Math.max(...stressValues) : 1;
  const stressCoords = scaledCoords(
    stressPoints,
    (point) => point.stress as number,
    stressMin,
    stressMax,
  );
  const maxStressCoords = scaledCoords(
    stressPoints,
    (point) => point.maxStress as number,
    stressMin,
    stressMax,
  );
  const limitY =
    PAD_TOP +
    (1 -
      (stressLimit - stressMin) /
        (stressMax > stressMin ? stressMax - stressMin : 1)) *
      (PLOT_H - PAD_TOP - PAD_BOTTOM);
  const lastStress = hasStress ? stressPoints[stressPoints.length - 1] : null;

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
        aria-label={
          hasStress
            ? "Convergence history: compliance, volume fraction and stress vs iteration"
            : "Convergence history: compliance and volume fraction vs iteration"
        }
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
        <path
          d={toPath(objCoords)}
          fill="none"
          stroke={OBJ_COLOR}
          strokeWidth={1.5}
        />
        <path
          d={toPath(volCoords)}
          fill="none"
          stroke={VOL_COLOR}
          strokeWidth={1.5}
        />
        {hasLimit && (
          <line
            data-testid="convergence-stress-limit"
            x1={PAD_LEFT}
            x2={PLOT_W - PAD_RIGHT}
            y1={limitY}
            y2={limitY}
            stroke={LIMIT_COLOR}
            strokeDasharray="2 3"
          />
        )}
        {hasStress && (
          <>
            <path
              d={toPath(stressCoords)}
              fill="none"
              stroke={STRESS_COLOR}
              strokeWidth={1.5}
            />
            <path
              d={toPath(maxStressCoords)}
              fill="none"
              stroke={MAX_STRESS_COLOR}
              strokeWidth={1.2}
              strokeDasharray="4 2"
            />
          </>
        )}
        {/* Point markers: a single-iteration run (maxIterations=1 or convergence
            on the first pass, and the first live frame) has no line segment to
            draw, so the dot is what makes that data point visible. */}
        {objCoords.map((pt, i) => (
          <circle key={i} cx={pt.x} cy={pt.y} r={1.6} fill={OBJ_COLOR} />
        ))}
        {volCoords.map((pt, i) => (
          <circle key={i} cx={pt.x} cy={pt.y} r={1.6} fill={VOL_COLOR} />
        ))}
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
          ■ Compliance {fmt(objFirst)} → {fmt(objLast)}
        </span>
        <span style={{ color: VOL_COLOR }}>
          ■ Volume fraction {points[points.length - 1].volume.toFixed(3)}
        </span>
        {lastStress && (
          <>
            <span style={{ color: STRESS_COLOR }}>
              ■ Aggregated σ {fmt(lastStress.stress as number)}
            </span>
            <span
              style={{ color: MAX_STRESS_COLOR }}
              data-testid="convergence-max-stress"
            >
              ■ True max σ {fmt(lastStress.maxStress as number)}
            </span>
            {hasLimit && (
              <span style={{ color: LIMIT_COLOR }}>
                ┄ σ_allow {fmt(stressLimit)}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

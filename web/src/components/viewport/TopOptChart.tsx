// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { topOptChartVisible } from "../../store/topOptSlice";
import { SMALL_SCREEN_QUERY } from "../../store/viewSlice";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useWorkerLogLines } from "../../hooks/useWorkerLogs";
import {
  chartFields,
  topOptChartLayout,
  type TopOptChartField,
} from "../../lib/topOptChart";
import {
  convergenceFromLogs,
  type ConvergencePoint,
} from "../../lib/topOptProgress";
import { resultUnit } from "../../lib/resultField";
import css from "./StudyChart.module.css";

// The topology optimization's convergence chart, in the centre in place of the
// 3D view while Results → Density is on its chart, like the mesh refinement
// study's: one field against the iteration, live while the run goes (from its
// streamed log lines), then from the returned history.

// A phone draws a narrower chart, so its text keeps its size.
const WIDE = {
  width: 640,
  height: 380,
  box: { left: 72, right: 596, top: 44, bottom: 300 },
};
const NARROW = {
  width: 360,
  height: 340,
  box: { left: 56, right: 340, top: 44, bottom: 264 },
};

const LABELS: Record<TopOptChartField, string> = {
  compliance: "Compliance",
  volume: "Volume",
  stress: "Stress",
};

function format(value: number): string {
  return Math.abs(value) >= 1e4 || (value !== 0 && Math.abs(value) < 1e-2)
    ? value.toExponential(2)
    : value.toPrecision(3);
}

export function TopOptChart() {
  const visible = useModelStore(topOptChartVisible);
  const densityResult = useModelStore((s) => s.densityResult);
  const isOptimizing = useModelStore((s) => s.isOptimizing);
  const settings = useModelStore((s) => s.topOpt);
  const logs = useWorkerLogLines("optimize");
  const [chosen, setChosen] = useState<TopOptChartField>("compliance");
  const small = useMediaQuery(SMALL_SCREEN_QUERY);

  // The finished run's history, or the run's log lines so far.
  const points: ConvergencePoint[] = useMemo(
    () =>
      densityResult
        ? densityResult.history.map((h) => ({
            it: h.it,
            compliance: h.compliance,
            volume: h.volume,
            ...(h.stress !== undefined && h.max_stress !== undefined
              ? { stress: h.stress, maxStress: h.max_stress }
              : {}),
          }))
        : convergenceFromLogs(logs),
    [densityResult, logs],
  );
  if (!visible) return null;

  const fields = chartFields(points);
  // A stress view left from a stress-bounded run falls back to compliance on
  // a run without stress, which has nothing else to show.
  const field = fields.includes(chosen) ? chosen : "compliance";
  // The bound of the constraint on this field. Changing a setting clears the
  // result, so the store's settings are the ones the run used.
  const limit = (text: string) => {
    const value = Number(text);
    return text.trim() !== "" && Number.isFinite(value) ? value : null;
  };
  const simp = settings.method === "simp";
  const bound =
    field === "volume" && settings.objective === "min_compliance"
      ? limit(settings.volumeFraction)
      : field === "compliance" && settings.objective === "min_volume"
        ? limit(settings.complianceLimit)
        : field === "stress" && simp && settings.stressConstraint
          ? limit(settings.maxStress)
          : null;
  const boundName =
    field === "volume"
      ? "Target"
      : field === "compliance"
        ? "Limit"
        : "σ_allow";
  const axis =
    field === "compliance"
      ? "Compliance"
      : field === "volume"
        ? "Volume fraction"
        : `Von Mises stress (${resultUnit("Von Mises stress")})`;

  const { width, height, box } = small ? NARROW : WIDE;
  const layout = topOptChartLayout(points, field, box, bound);
  const last = points[points.length - 1];
  const status = isOptimizing
    ? last === undefined
      ? "Optimizing · starting"
      : `Optimizing · iteration ${last.it} of ${settings.maxIterations}`
    : densityResult === null
      ? null
      : densityResult.converged
        ? `Converged after ${densityResult.iterations} iterations`
        : `Not converged: stopped at the ${densityResult.iterations}-iteration limit`;
  const range = layout.range;
  const ticks =
    range === null
      ? []
      : [range.max, (range.max + range.min) / 2, range.min].map((v) => ({
          value: v,
          y:
            range.max > range.min
              ? box.top +
                ((range.max - v) / (range.max - range.min)) *
                  (box.bottom - box.top)
              : (box.top + box.bottom) / 2,
        }));
  const main = layout.series.find((s) => s.kind === "value");
  const peak = layout.series.find((s) => s.kind === "maxStress");
  const lastPoint = main?.points[main.points.length - 1];

  return (
    <div
      className={css.overlay}
      data-testid="topopt-chart"
      data-points={points.length}
    >
      <div className={css.card}>
        <div className={css.header}>
          <span className={css.status} data-testid="topopt-chart-status">
            {status}
          </span>
          <div className={css.toggle} role="group" aria-label="Chart field">
            {fields.map((f) => (
              <button
                key={f}
                className={f === field ? css.toggleOn : css.toggleOff}
                aria-pressed={f === field}
                onClick={() => setChosen(f)}
              >
                {LABELS[f]}
              </button>
            ))}
          </div>
        </div>

        {main === undefined || range === null ? (
          <div className={css.empty}>The first iteration is on its way…</div>
        ) : (
          <>
            <svg
              className={css.svg}
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={`${axis} against iteration`}
            >
              <text className={css.axisTitle} x={box.left} y={box.top - 22}>
                {axis}
              </text>
              {ticks.map((t) => (
                <g key={t.y}>
                  <line
                    className={css.grid}
                    x1={box.left}
                    x2={box.right}
                    y1={t.y}
                    y2={t.y}
                  />
                  <text
                    className={css.tick}
                    x={box.left - 8}
                    y={t.y + 4}
                    textAnchor="end"
                  >
                    {format(t.value)}
                  </text>
                </g>
              ))}
              {layout.boundY !== null && (
                <line
                  data-testid="topopt-chart-bound"
                  className={css.bound}
                  x1={box.left}
                  x2={box.right}
                  y1={layout.boundY}
                  y2={layout.boundY}
                />
              )}
              {peak && (
                <polyline
                  className={css.lineSecondary}
                  points={peak.points.map((p) => `${p.x},${p.y}`).join(" ")}
                />
              )}
              <polyline
                className={css.line}
                points={main.points.map((p) => `${p.x},${p.y}`).join(" ")}
              />
              {main.points.map((p) => (
                <circle
                  key={p.it}
                  className={css.dot}
                  cx={p.x}
                  cy={p.y}
                  r={main.points.length > 40 ? 2 : 3.5}
                >
                  <title>{`Iteration ${p.it}: ${format(p.value)}`}</title>
                </circle>
              ))}
              {lastPoint && (
                <text
                  className={css.value}
                  x={lastPoint.x}
                  y={lastPoint.y - 12}
                  textAnchor="end"
                >
                  {format(lastPoint.value)}
                </text>
              )}
              {(main.points.length > 1
                ? [main.points[0], main.points[main.points.length - 1]]
                : main.points
              ).map((p) => (
                <text
                  key={p.it}
                  className={css.tick}
                  x={p.x}
                  y={box.bottom + 20}
                  textAnchor="middle"
                >
                  {p.it}
                </text>
              ))}
              <text
                className={css.axisTitle}
                x={(box.left + box.right) / 2}
                y={height - 8}
                textAnchor="middle"
              >
                Iteration
              </text>
            </svg>
            {(peak || bound !== null) && (
              <div className={css.legend}>
                {peak && (
                  <>
                    <span>
                      <span className={css.legendLine} />
                      Aggregated (the constraint)
                    </span>
                    <span data-testid="topopt-chart-max-stress">
                      <span className={css.legendLineSecondary} />
                      True max
                    </span>
                  </>
                )}
                {bound !== null && (
                  <span>
                    <span className={css.legendLineBound} />
                    {boundName} {format(bound)}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

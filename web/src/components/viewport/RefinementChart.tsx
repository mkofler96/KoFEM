// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { refinementChartVisible } from "../../store/studySlice";
import { SMALL_SCREEN_QUERY } from "../../store/viewSlice";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  bandLabel,
  chartLayout,
  type ChartBox,
  type ChartField,
} from "../../lib/refinementChart";
import {
  sizeLabel,
  studyFingerprint,
  verdictLine,
} from "../../lib/refinementStudy";
import css from "./StudyChart.module.css";

// The mesh refinement study's convergence chart (KOF-401), in the centre in
// place of the 3D view while Results → Mesh refinement is open: each level as
// it lands, element count on a log axis, and for displacement the band of the
// study's target error the verdict is judged by. A point opens its level in 3D once the study is
// done. Inline SVG, like the optimization's TopOptChart.

// Two drawings: a phone draws a narrower one, so its text keeps its size
// instead of shrinking with the whole chart.
const WIDE = {
  width: 640,
  height: 380,
  box: { left: 64, right: 596, top: 44, bottom: 296 },
};
const NARROW = {
  width: 360,
  height: 340,
  box: { left: 48, right: 340, top: 44, bottom: 256 },
};
// The points keep clear of the axes, so the first value label does not run
// into the y ticks.
const POINT_INSET = 36;

const FIELDS: {
  value: ChartField;
  label: string;
  axis: string;
  unit: string;
}[] = [
  {
    value: "displacement",
    label: "Displacement",
    axis: "Max |U|",
    unit: "mm",
  },
  { value: "stress", label: "Stress", axis: "Max σ_vm", unit: "MPa" },
];

export function RefinementChart() {
  const visible = useModelStore(refinementChartVisible);
  const run = useModelStore((s) => s.refinementStudy);
  const showLevel = useModelStore((s) => s.showRefinementLevel);
  const matches = useModelStore(
    (s) =>
      s.refinementStudy !== null &&
      studyFingerprint(s) === s.refinementStudy.fingerprint,
  );
  const [field, setField] = useState<ChartField>("displacement");
  const small = useMediaQuery(SMALL_SCREEN_QUERY);
  if (!visible || run === null) return null;

  const { width: WIDTH, height: HEIGHT, box: BOX } = small ? NARROW : WIDE;
  const pointBox: ChartBox = {
    ...BOX,
    left: BOX.left + POINT_INSET,
    right: BOX.right - POINT_INSET,
  };

  const spec = FIELDS.find((f) => f.value === field);
  if (spec === undefined) throw new Error(`Unknown chart field "${field}"`);
  const layout = chartLayout(run.levels, field, pointBox, run.settings);
  const openable = run.status === "done" && matches;
  const status =
    run.status === "running"
      ? run.step
      : run.status === "done" && run.levels.length >= 2
        ? verdictLine(run.levels, run.settings).text
        : run.status === "failed"
          ? "The study stopped — see the panel"
          : null;
  const range = layout.range;
  const ticks =
    range === null
      ? []
      : [range.max, (range.max + range.min) / 2, range.min].map((v) => ({
          value: v,
          y:
            BOX.top +
            ((range.max - v) / (range.max - range.min)) *
              (BOX.bottom - BOX.top),
        }));

  return (
    <div className={css.overlay} data-testid="refinement-chart">
      <div className={css.card}>
        <div className={css.header}>
          <span className={css.status} data-testid="refinement-chart-status">
            {status}
          </span>
          <div className={css.toggle} role="group" aria-label="Chart field">
            {FIELDS.map((f) => (
              <button
                key={f.value}
                className={f.value === field ? css.toggleOn : css.toggleOff}
                aria-pressed={f.value === field}
                onClick={() => setField(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {layout.points.length === 0 ? (
          <div className={css.empty}>
            {run.status === "running"
              ? "The first level is on its way…"
              : "No level to plot."}
          </div>
        ) : (
          <svg
            className={css.svg}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            role="img"
            aria-label={`${spec.axis} against element count`}
          >
            <text className={css.axisTitle} x={BOX.left} y={BOX.top - 22}>
              {spec.axis} ({spec.unit})
            </text>
            {ticks.map((t) => (
              <g key={t.y}>
                <line
                  className={css.grid}
                  x1={BOX.left}
                  x2={BOX.right}
                  y1={t.y}
                  y2={t.y}
                />
                <text
                  className={css.tick}
                  x={BOX.left - 8}
                  y={t.y + 4}
                  textAnchor="end"
                >
                  {t.value.toPrecision(3)}
                </text>
              </g>
            ))}

            {layout.bandY &&
              layout.referenceY !== null &&
              layout.reference !== null && (
                <g>
                  <rect
                    className={css.band}
                    x={BOX.left}
                    width={BOX.right - BOX.left}
                    y={layout.bandY.top}
                    height={layout.bandY.bottom - layout.bandY.top}
                  />
                  <line
                    className={css.reference}
                    x1={BOX.left}
                    x2={BOX.right}
                    y1={layout.referenceY}
                    y2={layout.referenceY}
                  />
                  <text
                    className={css.bandLabel}
                    x={BOX.right}
                    y={layout.bandY.top - 6}
                    textAnchor="end"
                  >
                    {bandLabel(layout, run.settings.tolerance)}
                  </text>
                </g>
              )}

            <polyline
              className={css.line}
              points={layout.points.map((p) => `${p.x},${p.y}`).join(" ")}
            />
            {layout.points.map((p) => (
              <g
                key={p.level}
                className={openable ? css.pointOpen : css.point}
                data-testid="refinement-chart-point"
                onClick={openable ? () => showLevel(p.level) : undefined}
              >
                <title>
                  {openable
                    ? `Open the ${sizeLabel(run.plannedSizes[p.level])} mm level in 3D`
                    : `${sizeLabel(run.plannedSizes[p.level])} mm level`}
                </title>
                <circle cx={p.x} cy={p.y} r={6} />
                <text
                  className={css.value}
                  x={p.x}
                  y={p.y - 12}
                  textAnchor="middle"
                >
                  {p.value.toPrecision(4)}
                </text>
                <text
                  className={css.tick}
                  x={p.x}
                  y={BOX.bottom + 20}
                  textAnchor="middle"
                >
                  {p.elements.toLocaleString("en-US")}
                </text>
                <text
                  className={css.tickSub}
                  x={p.x}
                  y={BOX.bottom + 35}
                  textAnchor="middle"
                >
                  {sizeLabel(run.plannedSizes[p.level])} mm
                </text>
              </g>
            ))}
            <text
              className={css.axisTitle}
              x={(BOX.left + BOX.right) / 2}
              y={HEIGHT - 8}
              textAnchor="middle"
            >
              Elements (log scale)
            </text>
          </svg>
        )}
      </div>
    </div>
  );
}

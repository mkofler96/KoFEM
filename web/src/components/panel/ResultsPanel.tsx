// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore, RESULT_TYPES } from "../../store/modelStore";
import type { DensityResult, ResultType } from "../../store/modelStore";
import {
  computeResultRange,
  resultFieldSymbol,
  resultUnit,
} from "../../lib/resultField";
import { visibleElementCount } from "../../lib/densityField";
import type { ConvergencePoint } from "../../lib/topOptProgress";
import { ConvergencePlot } from "./ConvergencePlot";
import { LegendRangeControls } from "./LegendRangeControls";
import styles from "./LeftPanel.module.css";

// The density-field result view (KOF-233): the threshold slider that filters the
// viewport, the convergence plot from the returned history, and the run summary.
// Shown whenever a topology-optimization run is the active result.
function TopOptSummary({ density, history }: DensityResult) {
  const threshold = useModelStore((s) => s.densityThreshold);
  const setDensityThreshold = useModelStore((s) => s.setDensityThreshold);

  let min = Infinity;
  let max = -Infinity;
  for (const d of density) {
    if (d < min) min = d;
    if (d > max) max = d;
  }
  const last = history[history.length - 1];
  const visible = visibleElementCount(density, threshold);
  const points: ConvergencePoint[] = history.map((h) => ({
    it: h.it,
    objective: h.objective,
    volume: h.volume,
  }));

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <div className={styles.sectionLabel}>Density threshold</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 4,
          }}
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={threshold}
            onChange={(e) => setDensityThreshold(parseFloat(e.target.value))}
            style={{ flex: 1 }}
            aria-label="Density threshold"
          />
          <span
            className={styles.statVal}
            style={{ minWidth: 38, textAlign: "right" }}
          >
            {threshold.toFixed(2)}
          </span>
        </div>
        <div className={styles.formNote} style={{ marginBottom: 12 }}>
          Elements below the cutoff are hidden, revealing the optimized shape.
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Visible elements</span>
          <span className={styles.statVal} data-testid="visible-element-count">
            {visible} / {density.length}
          </span>
        </div>

        {points.length > 0 && (
          <>
            <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
              Convergence
            </div>
            <ConvergencePlot points={points} />
          </>
        )}

        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
          Run summary
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Iterations</span>
          <span className={styles.statVal}>{history.length}</span>
        </div>
        {last && (
          <>
            <div className={styles.statRow}>
              <span className={styles.statKey}>Final volume frac.</span>
              <span className={styles.statVal}>{last.volume.toFixed(3)}</span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statKey}>Final objective</span>
              <span className={styles.statVal}>
                {last.objective.toExponential(3)}
              </span>
            </div>
          </>
        )}
        <div className={styles.statRow}>
          <span className={styles.statKey}>Density range</span>
          <span className={styles.statVal}>
            {min.toFixed(3)} – {max.toFixed(3)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function ResultsPanel() {
  const result = useModelStore((s) => s.result);
  const densityResult = useModelStore((s) => s.densityResult);
  const activeResult = useModelStore((s) => s.activeResult);
  const resultType = useModelStore((s) => s.resultType);
  const setResultType = useModelStore((s) => s.setResultType);
  const deformScale = useModelStore((s) => s.deformScale);
  const setDeformScale = useModelStore((s) => s.setDeformScale);
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);

  // Show the density when an optimization is the current result (it just ran, or
  // it is the only result present) — a static result left from an earlier solve
  // must not shadow it after the hand-off.
  if (densityResult && (activeResult === "density" || !result))
    return <TopOptSummary {...densityResult} />;

  if (!result) {
    return (
      <div className={styles.panel}>
        <div className={styles.tabContent}>
          <div className={styles.empty}>No results — run the solver first</div>
        </div>
      </div>
    );
  }

  // Min/max of the selected scalar field over all nodes — the same field and
  // node averaging used for the viewport coloring and colorbar legend.
  const stats = computeResultRange(result, resultType, nodes, elements);

  const fieldSymbol = resultFieldSymbol(resultType);
  const unit = resultUnit(resultType);

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <div className={styles.sectionLabel}>Field</div>
        <select
          className={styles.formSelect}
          style={{ marginBottom: 12 }}
          value={resultType}
          onChange={(e) => setResultType(e.target.value as ResultType)}
        >
          {RESULT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <div className={styles.sectionLabel}>Deformation scale</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <input
            type="range"
            min={0}
            max={3}
            step={0.05}
            value={deformScale}
            onChange={(e) => setDeformScale(parseFloat(e.target.value))}
            style={{ flex: 1 }}
            aria-label="Deformation scale"
          />
          <span
            className={styles.statVal}
            style={{ minWidth: 38, textAlign: "right" }}
          >
            {deformScale.toFixed(2)}×
          </span>
        </div>

        {stats && (
          <>
            <div className={styles.sectionLabel}>Legend range</div>
            <LegendRangeControls fieldRange={stats} unit={unit} />
          </>
        )}

        <div className={styles.sectionLabel}>Result summary</div>
        {stats ? (
          <>
            <div className={styles.statRow}>
              <span className={styles.statKey}>Min {fieldSymbol}</span>
              <span className={styles.statVal}>
                {stats.min.toExponential(3)} {unit}
              </span>
            </div>
            <div className={styles.statRow}>
              <span className={styles.statKey}>Max {fieldSymbol}</span>
              <span className={styles.statVal}>
                {stats.max.toExponential(3)} {unit}
              </span>
            </div>
          </>
        ) : (
          <div className={styles.empty}>
            {resultType === "Von Mises stress"
              ? "Von Mises data not available — re-run the solver"
              : "No nodal data"}
          </div>
        )}
      </div>
    </div>
  );
}

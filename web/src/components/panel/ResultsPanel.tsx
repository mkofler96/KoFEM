// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { useModelStore, RESULT_TYPES } from "../../store/modelStore";
import type {
  DensityResult,
  ResultPlot,
  ResultType,
  SolverResult,
} from "../../store/modelStore";
import type { TreeTarget } from "../../store/viewSlice";
import {
  computeResultRange,
  resultFieldSymbol,
  resultUnit,
} from "../../lib/resultField";
import { evaluateHandCheck, type HandCheck } from "../../lib/handCheck";
import type { ConvergencePoint } from "../../lib/topOptProgress";
import {
  buildDensityStl,
  buildSmoothDensityStl,
  densityStlFileName,
  levelSetField,
  nodalDensity,
} from "../../lib/densityField";
import { ConvergencePlot } from "./ConvergencePlot";
import { DensityThresholdControl } from "./DensityThresholdControl";
import { LegendRangeControls } from "./LegendRangeControls";
import styles from "./Panel.module.css";

// The density-field result view (KOF-233): the threshold slider that filters the
// viewport, the convergence plot from the returned history, and the run summary.
// Shown whenever a topology-optimization run is the active result.
function TopOptSummary({
  density,
  levelSet,
  history,
  footer,
}: DensityResult & { footer: ReactNode }) {
  // Changing any TO setting clears the density result, so the store's settings
  // are the ones this run used — including its σ_allow (KOF-236).
  const stressConstraint = useModelStore((s) => s.topOpt.stressConstraint);
  const maxStressText = useModelStore((s) => s.topOpt.maxStress);
  const stressLimit = stressConstraint ? Number(maxStressText) : NaN;
  const threshold = useModelStore((s) => s.densityThreshold);
  const smooth = useModelStore((s) => s.densitySmooth);
  // Something to export at this threshold: a level-set run has material where
  // its mapped φ reaches the cutoff; otherwise some element density must.
  const anyKept =
    smooth && levelSet
      ? levelSetField(levelSet).some((v) => v >= threshold)
      : density.some((d) => d >= threshold);
  let min = Infinity;
  let max = -Infinity;
  for (const d of density) {
    if (d < min) min = d;
    if (d > max) max = d;
  }
  const last = history[history.length - 1];
  const points: ConvergencePoint[] = history.map((h) => ({
    it: h.it,
    compliance: h.compliance,
    volume: h.volume,
    ...(h.stress !== undefined && h.max_stress !== undefined
      ? { stress: h.stress, maxStress: h.max_stress }
      : {}),
  }));

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <DensityThresholdControl density={density} />

        {points.length > 0 && (
          <>
            <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
              Convergence
            </div>
            <ConvergencePlot points={points} stressLimit={stressLimit} />
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
              <span className={styles.statKey}>Final compliance</span>
              <span className={styles.statVal}>
                {last.compliance.toExponential(3)}
              </span>
            </div>
            {last.max_stress !== undefined && (
              <div className={styles.statRow}>
                <span className={styles.statKey}>Max von Mises</span>
                <span
                  className={styles.statVal}
                  data-testid="topopt-final-max-stress"
                >
                  {last.max_stress.toExponential(3)}{" "}
                  {resultUnit("Von Mises stress")}
                  {Number.isFinite(stressLimit)
                    ? ` (limit ${stressLimit.toExponential(3)})`
                    : ""}
                </span>
              </div>
            )}
          </>
        )}
        <div className={styles.statRow}>
          <span className={styles.statKey}>Density range</span>
          <span className={styles.statVal}>
            {min.toFixed(3)} – {max.toFixed(3)}
          </span>
        </div>

        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
          Export
        </div>
        <button
          className={styles.outlineBtn}
          onClick={() =>
            downloadDensityStl(density, levelSet, threshold, smooth)
          }
          disabled={!anyKept}
        >
          Export shape as STL
        </button>
        <div className={styles.formNote} style={{ marginTop: 6 }}>
          {!anyKept
            ? "No material is kept at this threshold — lower it to export a shape."
            : smooth
              ? "The smooth surface shown at the current threshold, in model units."
              : "Faceted surface of the elements shown at the current threshold, in model units."}
        </div>
        {footer}
      </div>
    </div>
  );
}

// Writes the thresholded shape the viewport shows as a binary STL (KOF-239):
// the smooth surface in Smooth mode (the level set's own φ contour, or the
// node-averaged density for SIMP — the same field DensityField draws), the
// element boundary in Elements mode.
function downloadDensityStl(
  density: Float64Array,
  levelSet: Float64Array | undefined,
  threshold: number,
  smooth: boolean,
) {
  const { nodes, elements, modelName } = useModelStore.getState();
  let stl: ArrayBuffer | null;
  if (!smooth) stl = buildDensityStl(nodes, elements, density, threshold);
  else {
    const field = levelSet
      ? levelSetField(levelSet)
      : nodalDensity(nodes, elements, density);
    stl = field
      ? buildSmoothDensityStl(
          nodes,
          elements,
          field,
          threshold,
          levelSet ? "level set" : "density",
        )
      : null;
  }
  if (!stl)
    throw new Error(
      `STL export: no surface at threshold ${threshold} — the density (${density.length} values) does not match the current mesh or keeps no element`,
    );
  const url = URL.createObjectURL(new Blob([stl], { type: "model/stl" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = densityStlFileName(modelName, threshold);
  anchor.click();
  URL.revokeObjectURL(url);
}

// "Von Mises stress" → "von-mises-stress", for test ids.
function fieldSlug(field: ResultType): string {
  return field
    .toLowerCase()
    .replace(/[^a-z]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Results → + Add: pick the result to plot — a field of the static solve, or
// the optimization's density. A result its study has not produced yet cannot
// be picked.
function AddResultPlot() {
  const hasStatic = useModelStore((s) => s.result !== null);
  const hasDensity = useModelStore((s) => s.densityResult !== null);
  const addResultPlot = useModelStore((s) => s.addResultPlot);
  return (
    <div className={styles.addChooser}>
      {RESULT_TYPES.map((field) => (
        <button
          key={field}
          className={styles.addChoice}
          data-testid={`add-plot-${fieldSlug(field)}`}
          disabled={!hasStatic}
          onClick={() => addResultPlot("static", field)}
        >
          <span className={styles.addChoiceLabel}>{field}</span>
          <span className={styles.addChoiceHint}>
            {hasStatic
              ? `Static solve · ${resultUnit(field)}`
              : "Run a static study first"}
          </span>
        </button>
      ))}
      <button
        className={styles.addChoice}
        data-testid="add-plot-density"
        disabled={!hasDensity}
        onClick={() => addResultPlot("density", null)}
      >
        <span className={styles.addChoiceLabel}>Density</span>
        <span className={styles.addChoiceHint}>
          {hasDensity
            ? "Topology optimization · material layout"
            : "Run a topology optimization first"}
        </span>
      </button>
    </div>
  );
}

// The example's hand calculation beside its solved value (KOF-261).
function HandCheckNote({
  check,
  result,
}: {
  check: HandCheck;
  result: SolverResult;
}) {
  const nodes = useModelStore((s) => s.nodes);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const materials = useModelStore((s) => s.materials);
  const properties = useModelStore((s) => s.properties);
  const outcome = evaluateHandCheck(check, {
    nodes,
    loadGroups,
    materials,
    properties,
    result,
  });
  if (outcome === null) return null;
  // With a typographic minus, like the formula's.
  const mm = (value: number) => `${value.toFixed(3).replace("-", "−")} mm`;
  return (
    <p className={styles.handCheck} data-testid="hand-check">
      {outcome.kind === "changed" ? (
        "The load or material changed, so the hand calculation no longer applies."
      ) : (
        <>
          {check.quantity}{" "}
          <span data-testid="hand-check-fe">{mm(outcome.fe)}</span>; hand
          calculation {check.formula} ={" "}
          <span data-testid="hand-check-reference">{mm(check.reference)}</span>.
        </>
      )}
    </p>
  );
}

function Empty({ text, footer }: { text: string; footer: ReactNode }) {
  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <div className={styles.empty}>{text}</div>
        {footer}
      </div>
    </div>
  );
}

// One result plot: the density view of an optimization, or a field of the
// static solve with its scale, legend and summary.
function PlotDetail({ plot }: { plot: ResultPlot }) {
  const result = useModelStore((s) => s.result);
  const densityResult = useModelStore((s) => s.densityResult);
  const setPlotField = useModelStore((s) => s.setPlotField);
  const deleteResultPlot = useModelStore((s) => s.deleteResultPlot);
  const deformScale = useModelStore((s) => s.deformScale);
  const setDeformScale = useModelStore((s) => s.setDeformScale);
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const handCheck = useModelStore((s) => s.handCheck);

  const footer = (
    <button
      className={styles.dangerBtn}
      data-testid="delete-plot"
      onClick={() => deleteResultPlot(plot.id)}
    >
      Delete plot
    </button>
  );

  if (plot.source === "density")
    return densityResult ? (
      <TopOptSummary {...densityResult} footer={footer} />
    ) : (
      <Empty
        text="No density — run the topology optimization"
        footer={footer}
      />
    );

  if (!result || plot.field === null)
    return <Empty text="No results — run the static study" footer={footer} />;

  const resultType = plot.field;
  // Min/max of the selected scalar field over all nodes — the same field and
  // node averaging used for the viewport coloring and colorbar legend.
  const stats = computeResultRange(result, resultType, nodes, elements);

  const fieldSymbol = resultFieldSymbol(resultType);
  const unit = resultUnit(resultType);
  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {handCheck && <HandCheckNote check={handCheck} result={result} />}
        <div className={styles.sectionLabel}>Field</div>
        <select
          className={styles.formSelect}
          style={{ marginBottom: 12 }}
          data-testid="plot-field"
          value={resultType}
          onChange={(e) => setPlotField(plot.id, e.target.value as ResultType)}
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
        {footer}
      </div>
    </div>
  );
}

export function ResultsPanel({ target }: { target: TreeTarget }) {
  const plot = useModelStore((s) =>
    target.type === "item"
      ? s.resultPlots.find((p) => p.id === target.id)
      : undefined,
  );
  if (target.type === "item") return plot ? <PlotDetail plot={plot} /> : null;
  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <AddResultPlot />
      </div>
    </div>
  );
}

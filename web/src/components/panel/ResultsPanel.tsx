// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, type ReactNode } from "react";
import { useModelStore, RESULT_TYPES } from "../../store/modelStore";
import type {
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
import {
  evaluateHandCheck,
  formatHandCheckValue,
  type HandCheck,
} from "../../lib/handCheck";
import { isStressField, type ShellSurface } from "../../lib/stressFields";
import { probeLabel } from "../../lib/resultProbe";
import { useProbeReadings } from "../../hooks/useProbeReadings";
import { DeformScaleControl } from "./DeformScaleControl";
import { LegendRangeControls } from "./LegendRangeControls";
import { SectionControls } from "./SectionControls";
import { RefinementResult } from "./RefinementStudy";
import { TopOptResult } from "./TopOptResult";
import { SupportReactions } from "./SupportReactions";
import styles from "./Panel.module.css";

// "Von Mises stress" → "von-mises-stress", "Normal stress σxx" →
// "normal-stress-sigmaxx", for test ids.
function fieldSlug(field: ResultType): string {
  return field
    .toLowerCase()
    .replace(/σ/g, "sigma")
    .replace(/τ/g, "tau")
    .replace(/[^a-z]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Results → + Add: pick the result to plot — a field of the static solve, or
// the optimization's density. A result its study has not produced yet cannot
// be picked.
function AddResultPlot() {
  const hasStatic = useModelStore((s) => s.result !== null);
  const hasDensity = useModelStore((s) => s.densityResult !== null);
  const hasRefinement = useModelStore(
    (s) => s.refinementStudy?.status === "done",
  );
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
      <button
        className={styles.addChoice}
        data-testid="add-plot-refinement"
        disabled={!hasRefinement}
        onClick={() => addResultPlot("refinement", null)}
      >
        <span className={styles.addChoiceLabel}>Mesh refinement</span>
        <span className={styles.addChoiceHint}>
          {hasRefinement
            ? "Mesh refinement study · convergence"
            : "Run a mesh refinement study first"}
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
  const elements = useModelStore((s) => s.elements);
  const surfaceTriangles = useModelStore((s) => s.surfaceTriangles);
  const surfaceFaceIds = useModelStore((s) => s.surfaceFaceIds);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const bcGroups = useModelStore((s) => s.bcGroups);
  const materials = useModelStore((s) => s.materials);
  const properties = useModelStore((s) => s.properties);
  // A probe that cannot be read on this mesh is shown as such, with the reason,
  // rather than taking the whole panel down.
  const outcome = useMemo(() => {
    try {
      return evaluateHandCheck(check, {
        nodes,
        elements,
        surfaceTriangles,
        surfaceFaceIds,
        loadGroups,
        bcGroups,
        materials,
        properties,
        result,
      });
    } catch (err) {
      return {
        kind: "unreadable" as const,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }, [
    check,
    nodes,
    elements,
    surfaceTriangles,
    surfaceFaceIds,
    loadGroups,
    bcGroups,
    materials,
    properties,
    result,
  ]);
  const shown = (value: number) => formatHandCheckValue(value, check.unit);
  return (
    <p className={styles.handCheck} data-testid="hand-check">
      {outcome.kind === "changed" ? (
        "The loads, supports or material changed, so the hand calculation no longer applies."
      ) : outcome.kind === "unreadable" ? (
        `The hand calculation cannot be compared on this mesh. ${outcome.reason}`
      ) : (
        <>
          {check.quantity}{" "}
          <span data-testid="hand-check-fe" data-value={String(outcome.fe)}>
            {shown(outcome.fe)}
          </span>
          ; hand calculation {check.formula} ={" "}
          <span
            data-testid="hand-check-reference"
            data-value={String(check.reference)}
          >
            {shown(check.reference)}
          </span>
          .
        </>
      )}
    </p>
  );
}

// A vector in mm as the probe details show it: "(x, y, z) mm".
const formatVector = (v: readonly number[]) =>
  `(${v.map((c) => formatHandCheckValue(c, "")).join(", ")}) mm`;

// One probe row: name, field value and, for a placed probe, its remove button.
// The point and the displacement vector show on hover or focus.
function ProbeRow({
  testId,
  label,
  symbol,
  unit,
  reading,
  onRemove,
}: {
  testId: string;
  label: string;
  symbol: string;
  unit: "mm" | "MPa";
  reading:
    | { kind: "value"; at: number[]; displacement: number[]; value: number }
    | { kind: "unreadable"; reason: string }
    | null;
  onRemove?: () => void;
}) {
  return (
    <div
      className={styles.probeRow}
      data-testid={`probe-row-${testId}`}
      tabIndex={0}
    >
      <div className={styles.statRow}>
        <span className={styles.statKey}>
          {label} · {symbol}
        </span>
        <span className={styles.statValWithAction}>
          {reading?.kind === "value" ? (
            <span
              className={styles.statVal}
              data-testid={`probe-value-${testId}`}
              data-value={String(reading.value)}
            >
              {formatHandCheckValue(reading.value, unit)}
            </span>
          ) : (
            <span className={styles.statVal}>—</span>
          )}
          {onRemove && (
            <button
              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
              data-testid={`probe-remove-${testId}`}
              aria-label={`Remove ${label}`}
              title={`Remove ${label}`}
              onClick={onRemove}
            >
              ✕
            </button>
          )}
        </span>
      </div>
      {reading === null ? (
        <div className={styles.formNote}>Solve to read this probe.</div>
      ) : reading.kind === "unreadable" ? (
        <div className={styles.formNote}>
          Cannot be read on this mesh. {reading.reason}
        </div>
      ) : (
        <div
          className={`${styles.formNote} ${styles.probeDetails}`}
          data-testid={`probe-vector-${testId}`}
        >
          at {formatVector(reading.at)}
          <br />U = {formatVector(reading.displacement)}
        </div>
      )}
    </div>
  );
}

// Result probes (KOF-389): the min and max of the plotted field, the tool that
// places probes by clicking the model, and a row per probe.
function ProbeSection({ field }: { field: ResultType }) {
  const probing = useModelStore((s) => s.probing);
  const setProbing = useModelStore((s) => s.setProbing);
  const removeProbe = useModelStore((s) => s.removeProbe);
  const showExtremes = useModelStore((s) => s.showExtremeProbes);
  const setShowExtremes = useModelStore((s) => s.setShowExtremeProbes);
  const { placed, extremes } = useProbeReadings();
  const unit = resultUnit(field);
  const symbol = resultFieldSymbol(field);
  return (
    <>
      <div className={styles.sectionLabel}>Probes</div>
      <label className={styles.statRow} style={{ justifyContent: "start" }}>
        <input
          type="checkbox"
          data-testid="probe-extremes"
          checked={showExtremes}
          onChange={(e) => setShowExtremes(e.target.checked)}
        />
        <span className={styles.statKey} style={{ marginLeft: 6 }}>
          Show min and max
        </span>
      </label>
      {extremes?.kind === "unreadable" && (
        <div className={styles.formNote}>
          Min and max cannot be read. {extremes.reason}
        </div>
      )}
      {extremes?.kind === "value" &&
        (["min", "max"] as const).map((end) => (
          <ProbeRow
            key={end}
            testId={end}
            label={end === "min" ? "Min" : "Max"}
            symbol={symbol}
            unit={unit}
            reading={{ kind: "value", ...extremes[end] }}
          />
        ))}
      <button
        className={styles.outlineBtn}
        data-testid="probe-toggle"
        aria-pressed={probing}
        onClick={() => setProbing(!probing)}
      >
        {probing ? "Stop placing probes" : "Place probes"}
      </button>
      {probing && (
        <div className={styles.formNote} style={{ marginTop: 6 }}>
          Click the model to read {symbol} there.
        </div>
      )}
      <div style={{ marginTop: 8, marginBottom: 12 }}>
        {placed.map(({ probe, reading }) => (
          <ProbeRow
            key={probe.id}
            testId={String(probe.id)}
            label={probeLabel(probe)}
            symbol={symbol}
            unit={unit}
            reading={reading}
            onRemove={() => removeProbe(probe.id)}
          />
        ))}
      </div>
    </>
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
  const isOptimizing = useModelStore((s) => s.isOptimizing);
  const topOptRunRequested = useModelStore((s) => s.topOptRunRequested);
  const topOptError = useModelStore((s) => s.topOptError);
  const setPlotField = useModelStore((s) => s.setPlotField);
  const deleteResultPlot = useModelStore((s) => s.deleteResultPlot);
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const shellSurface = useModelStore((s) => s.shellSurface);
  const setShellSurface = useModelStore((s) => s.setShellSurface);
  const handCheck = useModelStore((s) => s.handCheck);
  const refinementStudy = useModelStore((s) => s.refinementStudy);

  const footer = (
    <button
      className={styles.dangerBtn}
      data-testid="delete-plot"
      onClick={() => deleteResultPlot(plot.id)}
    >
      Delete plot
    </button>
  );

  if (plot.source === "refinement")
    return refinementStudy ? (
      <div className={styles.panel}>
        <div className={styles.tabContent}>
          <RefinementResult run={refinementStudy} />
          {footer}
        </div>
      </div>
    ) : (
      <Empty
        text="No refinement study — run the mesh refinement study"
        footer={footer}
      />
    );

  // A run shows here from its start (it hands off to Results), while a "Run
  // again" request waits for the hook to start it, and with its error after
  // it failed.
  if (plot.source === "density")
    return densityResult !== null ||
      isOptimizing ||
      topOptRunRequested ||
      topOptError !== null ? (
      <TopOptResult footer={footer} />
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
  const stats = computeResultRange(
    result,
    resultType,
    nodes,
    elements,
    shellSurface,
  );
  // The surface choice matters only for a stress component on a shell.
  const surfaceChoice =
    isStressField(resultType) && elements.some((e) => e.type === "CTRIA3");

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

        {surfaceChoice && (
          <>
            <div className={styles.sectionLabel}>Shell surface</div>
            <select
              className={styles.formSelect}
              style={{ marginBottom: 12 }}
              data-testid="shell-surface"
              value={shellSurface}
              onChange={(e) => setShellSurface(e.target.value as ShellSurface)}
            >
              <option value="top">Top (+normal)</option>
              <option value="middle">Middle</option>
              <option value="bottom">Bottom (−normal)</option>
            </select>
          </>
        )}

        <DeformScaleControl />

        <SectionControls field={resultType} />

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
            {resultType === "Von Mises stress" || isStressField(resultType)
              ? "Stress data not available — re-run the solver"
              : "No nodal data"}
          </div>
        )}
        {result.reactions && (
          <div style={{ marginTop: 12 }}>
            <SupportReactions summary={result.reactions} />
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <ProbeSection field={resultType} />
        </div>
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

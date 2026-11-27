// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState, type ReactNode } from "react";
import { useModelStore, RESULT_TYPES } from "../../store/modelStore";
import type {
  ResultPlot,
  ResultType,
  SolverResult,
} from "../../store/modelStore";
import type { TreeTarget } from "../../store/viewSlice";
import { plotLabel } from "../../store/studySlice";
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
import { useFieldPercentiles } from "../../hooks/useFieldPercentiles";
import { DeformScaleControl } from "./DeformScaleControl";
import { SectionControls } from "./SectionControls";
import { RefinementResult } from "./RefinementStudy";
import { TopOptResult } from "./TopOptResult";
import { SupportReactions } from "./SupportReactions";
import { useT } from "../../i18n/useLocale";
import {
  resultFieldMessages,
  resultsMessages,
} from "../../i18n/messages/results";
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
  const addPlotSection = useModelStore((s) => s.addPlotSection);
  const showReactions = useModelStore((s) => s.showReactions);
  const addReactions = useModelStore((s) => s.addReactions);
  // A cut is added to the plot on screen, a field of the static solve.
  const shownPlot = useModelStore((s) =>
    s.resultPlots.find((p) => p.id === s.shownPlotId && p.source === "static"),
  );
  const text = useT(resultsMessages);
  const fields = useT(resultFieldMessages);
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
          <span className={styles.addChoiceLabel}>{fields[field]}</span>
          <span className={styles.addChoiceHint}>
            {hasStatic
              ? text.staticSolveHint(resultUnit(field))
              : text.runStaticFirst}
          </span>
        </button>
      ))}
      <button
        className={styles.addChoice}
        data-testid="add-plot-section"
        disabled={!shownPlot || shownPlot.section !== null}
        onClick={() => shownPlot && addPlotSection(shownPlot.id)}
      >
        <span className={styles.addChoiceLabel}>{text.sectionCut}</span>
        <span className={styles.addChoiceHint}>
          {!shownPlot
            ? text.showStaticFieldFirst
            : shownPlot.section !== null
              ? text.alreadyHasCut(plotLabel(shownPlot))
              : text.cutThrough(plotLabel(shownPlot))}
        </span>
      </button>
      <button
        className={styles.addChoice}
        data-testid="add-reactions"
        disabled={!hasStatic || showReactions}
        onClick={addReactions}
      >
        <span className={styles.addChoiceLabel}>{text.reactions}</span>
        <span className={styles.addChoiceHint}>
          {!hasStatic
            ? text.runStaticFirst
            : showReactions
              ? text.alreadyListed
              : text.reactionsHint}
        </span>
      </button>
      <button
        className={styles.addChoice}
        data-testid="add-plot-density"
        disabled={!hasDensity}
        onClick={() => addResultPlot("density", null)}
      >
        <span className={styles.addChoiceLabel}>{text.density}</span>
        <span className={styles.addChoiceHint}>
          {hasDensity ? text.densityHint : text.runTopOptFirst}
        </span>
      </button>
      <button
        className={styles.addChoice}
        data-testid="add-plot-refinement"
        disabled={!hasRefinement}
        onClick={() => addResultPlot("refinement", null)}
      >
        <span className={styles.addChoiceLabel}>{text.meshRefinement}</span>
        <span className={styles.addChoiceHint}>
          {hasRefinement ? text.refinementHint : text.runRefinementFirst}
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
  const text = useT(resultsMessages);
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
        text.handCheckChanged
      ) : outcome.kind === "unreadable" ? (
        text.handCheckUnreadable(outcome.reason)
      ) : (
        <>
          {check.quantity}{" "}
          <span data-testid="hand-check-fe" data-value={String(outcome.fe)}>
            {shown(outcome.fe)}
          </span>
          ; {text.handCalculation} {check.formula} ={" "}
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
  name,
  formatValue,
  reading,
  onRemove,
}: {
  testId: string;
  // The probe's name, for the remove button; `name` is the row's key text.
  label: string;
  name: string;
  formatValue: (value: number) => string;
  reading:
    | { kind: "value"; at: number[]; displacement: number[]; value: number }
    | { kind: "unreadable"; reason: string }
    | null;
  onRemove?: () => void;
}) {
  const text = useT(resultsMessages);
  return (
    <div
      className={styles.probeRow}
      data-testid={`probe-row-${testId}`}
      tabIndex={0}
    >
      <div className={styles.statRow}>
        <span className={styles.statKey}>{name}</span>
        <span className={styles.statValWithAction}>
          {reading?.kind === "value" ? (
            <span
              className={styles.statVal}
              data-testid={`probe-value-${testId}`}
              data-value={String(reading.value)}
            >
              {formatValue(reading.value)}
            </span>
          ) : (
            <span className={styles.statVal}>—</span>
          )}
          {onRemove && (
            <button
              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
              data-testid={`probe-remove-${testId}`}
              aria-label={text.remove(label)}
              title={text.remove(label)}
              onClick={onRemove}
            >
              ✕
            </button>
          )}
        </span>
      </div>
      {reading === null ? (
        <div className={styles.formNote}>{text.solveToRead}</div>
      ) : reading.kind === "unreadable" ? (
        <div className={styles.formNote}>
          {text.cannotReadOnMesh(reading.reason)}
        </div>
      ) : (
        <div
          className={`${styles.formNote} ${styles.probeDetails}`}
          data-testid={`probe-vector-${testId}`}
        >
          {text.probeAt(formatVector(reading.at))}
          <br />U = {formatVector(reading.displacement)}
        </div>
      )}
    </div>
  );
}

// The min and max of the plotted field, over every node like the legend: always
// listed here, labelled in the view while the checkbox is on (KOF-389). The
// values keep the format the example pages publish ("1.909e+0 mm").
function MinMaxSection({ field }: { field: ResultType }) {
  const showExtremes = useModelStore((s) => s.showExtremeProbes);
  const setShowExtremes = useModelStore((s) => s.setShowExtremeProbes);
  const { extremes } = useProbeReadings();
  const unit = resultUnit(field);
  const symbol = resultFieldSymbol(field);
  const text = useT(resultsMessages);
  return (
    <>
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel}>{text.minAndMax}</span>
        <label className={styles.sectionHeadAction}>
          <input
            type="checkbox"
            data-testid="probe-extremes"
            checked={showExtremes}
            onChange={(e) => setShowExtremes(e.target.checked)}
          />
          {text.labelInView}
        </label>
      </div>
      {extremes?.kind === "unreadable" && (
        <div className={styles.formNote}>
          {text.minMaxUnreadable(extremes.reason)}
        </div>
      )}
      {extremes?.kind === "value" &&
        (["min", "max"] as const).map((end) => (
          <ProbeRow
            key={end}
            testId={end}
            label={text[end]}
            name={`${text[end]} ${symbol}`}
            formatValue={(v) => `${v.toExponential(3)} ${unit}`}
            reading={{ kind: "value", ...extremes[end] }}
          />
        ))}
      <PercentileRows symbol={symbol} unit={unit} />
    </>
  );
}

// The von Mises percentiles by volume (KOF-477), under the max: the number a
// part is judged on when the max sits at a singularity.
function PercentileRows({ symbol, unit }: { symbol: string; unit: string }) {
  const percentiles = useFieldPercentiles();
  const text = useT(resultsMessages);
  if (percentiles === null) return null;
  if (percentiles.kind === "unreadable")
    return (
      <div className={styles.formNote}>
        {text.percentileUnreadable(percentiles.reason)}
      </div>
    );
  return percentiles.values.map(({ percent, value }) => (
    <div
      key={percent}
      className={styles.statRow}
      data-testid={`percentile-row-${percent}`}
      title={text.percentileHint(percent)}
    >
      <span className={styles.statKey}>
        {text.percentile(percent)} {symbol}
      </span>
      <span
        className={styles.statVal}
        data-testid={`percentile-value-${percent}`}
        data-value={String(value)}
      >
        {value.toExponential(3)} {unit}
      </span>
    </div>
  ));
}

// Result probes (KOF-389): the tool that places probes by clicking the model,
// and a row per probe.
function ProbeSection({ field }: { field: ResultType }) {
  const probing = useModelStore((s) => s.probing);
  const setProbing = useModelStore((s) => s.setProbing);
  const removeProbe = useModelStore((s) => s.removeProbe);
  const { placed } = useProbeReadings();
  const unit = resultUnit(field);
  const symbol = resultFieldSymbol(field);
  const text = useT(resultsMessages);
  return (
    <>
      <div className={styles.sectionLabel}>{text.probes}</div>
      {placed.map(({ probe, reading }) => (
        <ProbeRow
          key={probe.id}
          testId={String(probe.id)}
          label={probeLabel(probe)}
          name={`${probeLabel(probe)} · ${symbol}`}
          formatValue={(v) => formatHandCheckValue(v, unit)}
          reading={reading}
          onRemove={() => removeProbe(probe.id)}
        />
      ))}
      <button
        className={styles.outlineBtn}
        data-testid="probe-toggle"
        aria-pressed={probing}
        onClick={() => setProbing(!probing)}
      >
        {probing ? text.stopPlacingProbes : text.placeProbes}
      </button>
      {probing && (
        <div className={styles.formNote} style={{ marginTop: 6 }}>
          {text.clickToRead(symbol)}
        </div>
      )}
      <ProbeAtPoint symbol={symbol} />
    </>
  );
}

// A probe at typed coordinates (KOF-447): it reads the surface point nearest
// them, so a published value at a named point can be read exactly.
function ProbeAtPoint({ symbol }: { symbol: string }) {
  const addProbeAt = useModelStore((s) => s.addProbeAt);
  const [coords, setCoords] = useState(["", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const text = useT(resultsMessages);
  const add = () => {
    const point = coords.map((c) => (c.trim() === "" ? Number.NaN : Number(c)));
    if (!point.every(Number.isFinite)) {
      setError(text.enterXyz);
      return;
    }
    try {
      addProbeAt([point[0], point[1], point[2]]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div style={{ marginTop: 8 }}>
      <div className={`${styles.formNote} ${styles.formNoteFull}`}>
        {text.readAtPoint(symbol)}
      </div>
      <div className={styles.coordRow}>
        {(["x", "y", "z"] as const).map((axis, i) => (
          <input
            key={axis}
            className={styles.formInput}
            data-testid={`probe-at-${axis}`}
            aria-label={text.probeAxis(axis)}
            placeholder={axis}
            inputMode="decimal"
            value={coords[i]}
            onChange={(e) =>
              setCoords(coords.map((c, k) => (k === i ? e.target.value : c)))
            }
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
        ))}
        <button
          className={styles.outlineBtn}
          data-testid="probe-at-add"
          onClick={add}
        >
          {text.add}
        </button>
      </div>
      {error && (
        <div
          className={`${styles.formNote} ${styles.formNoteFull}`}
          data-testid="probe-at-error"
        >
          {error}
        </div>
      )}
    </div>
  );
}

function Empty({ message, footer }: { message: string; footer: ReactNode }) {
  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <div className={styles.empty}>{message}</div>
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
  const text = useT(resultsMessages);
  const fields = useT(resultFieldMessages);

  const footer = (
    <button
      className={styles.dangerLink}
      data-testid="delete-plot"
      onClick={() => deleteResultPlot(plot.id)}
    >
      {text.deletePlot}
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
      <Empty message={text.noRefinement} footer={footer} />
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
      <Empty message={text.noDensity} footer={footer} />
    );

  if (!result || plot.field === null)
    return <Empty message={text.noResults} footer={footer} />;

  const resultType = plot.field;
  // The range of the plotted field over all nodes — the same field and node
  // averaging as the viewport colouring; null when the field has no data.
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
  // Shown, then how it is drawn, then what it reads.
  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {handCheck && <HandCheckNote check={handCheck} result={result} />}
        <div className={styles.sectionLabel}>{text.field}</div>
        <select
          className={styles.formSelect}
          data-testid="plot-field"
          value={resultType}
          onChange={(e) => setPlotField(plot.id, e.target.value as ResultType)}
        >
          {RESULT_TYPES.map((type) => (
            <option key={type} value={type}>
              {fields[type]}
            </option>
          ))}
        </select>

        {surfaceChoice && (
          <>
            <div className={styles.sectionLabel}>{text.shellSurface}</div>
            <select
              className={styles.formSelect}
              style={{ marginBottom: 12 }}
              data-testid="shell-surface"
              value={shellSurface}
              onChange={(e) => setShellSurface(e.target.value as ShellSurface)}
            >
              <option value="top">{text.surfaceTop}</option>
              <option value="middle">{text.surfaceMiddle}</option>
              <option value="bottom">{text.surfaceBottom}</option>
            </select>
          </>
        )}

        {!stats && (
          <div className={styles.empty}>
            {resultType === "Von Mises stress" || isStressField(resultType)
              ? text.noStressData
              : text.noNodalData}
          </div>
        )}

        <DeformScaleControl />

        {stats && <MinMaxSection field={resultType} />}

        <ProbeSection field={resultType} />

        {footer}
      </div>
    </div>
  );
}

// Results → Reactions: the support reactions of the latest static solve, a
// result output of its own rather than part of every plot (KOF-387).
function ReactionsPanel() {
  const reactions = useModelStore((s) => s.result?.reactions ?? null);
  const deleteReactions = useModelStore((s) => s.deleteReactions);
  const display = useModelStore((s) => s.reactionsDisplay);
  const setDisplay = useModelStore((s) => s.setReactionsDisplay);
  const text = useT(resultsMessages);
  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>{text.arrowsInView}</span>
        </div>
        <div className={styles.segToggle} role="group" aria-label={text.arrows}>
          {(["resultant", "nodal"] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={`${styles.segBtn} ${display === option ? styles.segBtnActive : ""}`}
              aria-pressed={display === option}
              onClick={() => setDisplay(option)}
            >
              {option === "resultant" ? text.resultant : text.nodal}
            </button>
          ))}
        </div>
        {reactions ? (
          <SupportReactions summary={reactions} />
        ) : (
          <div className={styles.empty}>{text.runToComputeReactions}</div>
        )}
        <button
          className={styles.dangerLink}
          data-testid="delete-reactions"
          onClick={deleteReactions}
        >
          {text.deleteReactions}
        </button>
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
  if (target.type === "item" && target.kind === "section")
    return plot?.section && plot.field !== null ? (
      <div className={styles.panel}>
        <div className={styles.tabContent}>
          <SectionControls
            plotId={plot.id}
            section={plot.section}
            field={plot.field}
          />
        </div>
      </div>
    ) : null;
  if (target.type === "item" && target.kind === "reactions")
    return <ReactionsPanel />;
  if (target.type === "item") return plot ? <PlotDetail plot={plot} /> : null;
  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <AddResultPlot />
      </div>
    </div>
  );
}

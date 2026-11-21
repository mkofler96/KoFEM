// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import {
  assessConvergence,
  REFINEMENT_RATIOS,
  sizeLabel,
  studyFingerprint,
  verdictLine,
  type RefinementFieldErrors,
  type RefinementSettingsInput,
} from "../../lib/refinementStudy";
import type { RefinementStudyRun, Study } from "../../store/studySlice";
import { RESULT_TYPES, useModelStore } from "../../store/modelStore";
import type { ResultType } from "../../store/resultsSlice";
import { useEngineGate } from "../../store/engineStore";
import { useSolver } from "../../hooks/useSolver";
import { useRefinementStudy } from "../../hooks/useRefinementStudy";
import { LogSection } from "./LogSection";
import styles from "./Panel.module.css";
import own from "./RefinementStudy.module.css";

// Mesh refinement study (KOF-401): the study's panel under Studies, which runs
// it, and its result under Results — the verdict, the convergence chart (drawn
// in the centre, RefinementChart) and the levels, each of which opens in 3D.

// "25, 17.7 and 12.5"
function listSizes(sizes: number[]): string {
  const labels = sizes.map(sizeLabel);
  return labels.length < 2
    ? labels.join("")
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function percent(fraction: number): string {
  const pct = fraction * 100;
  return `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct).toFixed(1)} %`;
}

// One typed setting with its inline validation message. The value is the raw
// text (parsed in useRefinementStudy), so an invalid field shows its error and
// blocks the run instead of falling back to a default.
function SettingField({
  field,
  label,
  errors,
}: {
  field: Exclude<keyof RefinementSettingsInput, "ratio">;
  label: string;
  errors: RefinementFieldErrors;
}) {
  const value = useModelStore((s) => s.refinementInput[field]);
  const setSetting = useModelStore((s) => s.setRefinementSetting);
  const err = errors[field];
  return (
    <>
      <div className={styles.formRow}>
        <label className={styles.formLabel}>{label}</label>
        <input
          className={styles.formInput}
          type="text"
          inputMode="decimal"
          value={value}
          aria-label={label}
          aria-invalid={err !== undefined}
          data-testid={`refinement-${field}`}
          onChange={(e) => setSetting(field, e.target.value)}
        />
      </div>
      {err && <div className={styles.fieldError}>{err}</div>}
    </>
  );
}

// The study under Studies: its settings and the one button. The static case's
// own checks are not repeated: a static study that solves is ready to refine,
// and one that does not says why on its own panel. Run hands off to Results,
// where the study's progress shows.
export function RefinementStudyPanel({
  staticCase,
  header,
  footer,
}: {
  staticCase: Study | null;
  header: ReactNode;
  footer: ReactNode;
}) {
  const { isRunning, allOk, checks, elementOrder, logs } = useSolver();
  const { run, refusal, settingsErrors, plannedSizes, start } =
    useRefinementStudy();
  const ratio = useModelStore((s) => s.refinementInput.ratio);
  const setSetting = useModelStore((s) => s.setRefinementSetting);
  const engine = useEngineGate();
  const running = run?.status === "running";
  const notReady = checks.find(([ok]) => !ok);
  const blocked =
    staticCase === null
      ? "Pick the static study to refine."
      : !allOk && notReady !== undefined
        ? `${staticCase.name} is not ready to solve: ${notReady[1]}.`
        : refusal;
  const settingsOk = Object.keys(settingsErrors).length === 0;

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {header}

        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
          Study settings
        </div>
        <SettingField field="levels" label="Levels" errors={settingsErrors} />
        <div className={styles.formRow}>
          <label className={styles.formLabel} htmlFor="refinement-ratio">
            Refine by
          </label>
          <select
            id="refinement-ratio"
            className={styles.formSelect}
            data-testid="refinement-ratio"
            value={ratio}
            onChange={(e) => setSetting("ratio", e.target.value)}
          >
            {REFINEMENT_RATIOS.map((r) => (
              <option key={r.value} value={String(r.value)}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        {settingsErrors.ratio && (
          <div className={styles.fieldError}>{settingsErrors.ratio}</div>
        )}
        <SettingField
          field="tolerance"
          label="Target error (%)"
          errors={settingsErrors}
        />
        <div className={styles.statRow}>
          <span className={styles.statKey}>Element order</span>
          <span className={styles.statVal}>
            {elementOrder === 2
              ? "Quadratic (2nd order)"
              : "Linear (1st order)"}
          </span>
        </div>

        <button
          className={styles.solveBtn}
          data-testid="refinement-study-run"
          disabled={
            !allOk ||
            isRunning ||
            engine.blocked ||
            blocked !== null ||
            !settingsOk
          }
          title={engine.reason}
          onClick={start}
        >
          {running ? "Running study…" : "▶  Run mesh refinement study"}
        </button>
        {blocked !== null ? (
          <div className={own.note} data-testid="refinement-study-refusal">
            {blocked}
          </div>
        ) : (
          plannedSizes !== null &&
          !running && (
            <div className={own.hint} data-testid="refinement-study-plan">
              Solves at {listSizes(plannedSizes)} mm and checks that the result
              settles.
            </div>
          )
        )}

        <LogSection logs={logs} busy={isRunning} />
        {footer}
      </div>
    </div>
  );
}

// One planned level: solved (a button that opens it), being worked on, or
// still to come.
function LevelRow({
  index,
  run,
  shown,
  current,
  locked,
  onOpen,
}: {
  index: number;
  run: RefinementStudyRun;
  shown: boolean;
  current: boolean;
  locked: boolean;
  onOpen: () => void;
}) {
  const size = `${sizeLabel(run.plannedSizes[index])} mm`;
  const level = run.levels[index];
  if (level === undefined) {
    const working = run.status === "running" && index === run.levels.length;
    const status = working
      ? run.phase === "meshing"
        ? "Meshing…"
        : "Solving…"
      : run.status === "running"
        ? "Waiting"
        : "—";
    return (
      <div className={`${own.row} ${own.rowPending}`}>
        <span className={own.rowMain}>{size}</span>
        <span className={own.rowValue}>{status}</span>
      </div>
    );
  }
  const previous = run.levels[index - 1];
  const change =
    previous === undefined
      ? null
      : (level.maxDisplacement - previous.maxDisplacement) /
        previous.maxDisplacement;
  return (
    <button
      className={`${own.row} ${shown ? own.rowShown : ""}`}
      data-testid="refinement-study-level"
      data-size={level.sizes.max}
      data-elements={level.elements}
      data-nodes={level.nodes}
      data-max-displacement={level.maxDisplacement}
      aria-current={shown}
      disabled={locked}
      title={locked ? undefined : "Open this level in 3D"}
      onClick={onOpen}
    >
      <span className={own.rowMain}>
        {size}
        <span className={own.rowSub}>
          {level.elements.toLocaleString("en-US")} elements
          {current && !shown && " · current mesh"}
        </span>
      </span>
      <span className={own.rowValue}>
        {level.maxDisplacement.toPrecision(4)} mm
        {change !== null && (
          <span className={own.rowSub}>{percent(change)}</span>
        )}
      </span>
    </button>
  );
}

// The study's result under Results: the verdict, then the chart and the levels
// to choose from. The chart or the opened level fills the centre.
export function RefinementResult({ run }: { run: RefinementStudyRun }) {
  const shown = useModelStore((s) => s.refinementLevelShown);
  const showLevel = useModelStore((s) => s.showRefinementLevel);
  const nodes = useModelStore((s) => s.nodes);
  const resultType = useModelStore((s) => s.resultType);
  const setResultType = useModelStore((s) => s.setResultType);
  // The levels are of the model the study solved; an edit since makes them
  // another model's.
  const stale = useModelStore(
    (s) => run.status !== "running" && studyFingerprint(s) !== run.fingerprint,
  );
  const done = run.status === "done" && run.levels.length >= 2;
  const assessment = done ? assessConvergence(run.levels, run.settings) : null;
  const line = done ? verdictLine(run.levels, run.settings) : null;

  return (
    <div className={own.result}>
      {run.error && (
        <div
          className={styles.errorBanner}
          data-testid="refinement-study-error"
        >
          <span>{run.error}</span>
        </div>
      )}
      {line && (
        <div
          className={line.converged ? own.converged : own.notConverged}
          data-testid="refinement-study-verdict"
        >
          {line.text}
        </div>
      )}
      {assessment?.stressRising && (
        <div className={own.note} data-testid="refinement-study-stress-note">
          The peak stress keeps rising as the mesh refines: a sharp corner,
          support or point load. Judge the stress away from it.
        </div>
      )}
      {run.stopNote && <div className={own.note}>{run.stopNote}</div>}

      <div className={own.list}>
        <button
          className={`${own.row} ${shown === null ? own.rowShown : ""}`}
          data-testid="refinement-chart-row"
          aria-current={shown === null}
          onClick={() => showLevel(null)}
        >
          <span className={own.rowMain}>Convergence chart</span>
        </button>
        {run.plannedSizes.map((size, i) => (
          <LevelRow
            key={size}
            index={i}
            run={run}
            shown={shown === i}
            current={run.snapshots[i]?.nodes === nodes}
            locked={run.status === "running" || stale}
            onOpen={() => showLevel(i)}
          />
        ))}
      </div>

      {stale ? (
        <div className={own.note} data-testid="refinement-study-stale">
          The model changed since this study, so its levels no longer match it.
          Run the study again to open them.
        </div>
      ) : (
        run.status === "done" && (
          <div className={own.hint}>
            Opening a level makes it the model&apos;s mesh.
          </div>
        )
      )}

      {shown !== null && (
        <select
          className={styles.formSelect}
          style={{ marginTop: 12 }}
          data-testid="refinement-level-field"
          value={resultType}
          onChange={(e) => setResultType(e.target.value as ResultType)}
        >
          {RESULT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

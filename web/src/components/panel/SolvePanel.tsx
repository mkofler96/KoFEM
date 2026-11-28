// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, type ReactNode } from "react";
import type { Study } from "../../store/modelStore";
import { useSolver } from "../../hooks/useSolver";
import { useEngineGate } from "../../store/engineStore";
import { LogSection } from "./LogSection";
import { PreflightChecks } from "./PreflightChecks";
import { isSolverMethod, SOLVER_METHODS } from "../../lib/solve/amg";
import {
  isLoadIncrementCount,
  MAX_LOAD_INCREMENTS,
} from "../../lib/solve/largeDeformation";
import { useT } from "../../i18n/useLocale";
import { solveMessages } from "../../i18n/messages/solve";
import { FailureBanner } from "./FailureBanner";
import styles from "./Panel.module.css";

// One static study: the pre-flight check, the solver settings and the run.
// `header` / `footer` carry the study's own controls.
export function SolvePanel({
  study,
  header,
  footer,
}: {
  study: Study;
  header: ReactNode;
  footer: ReactNode;
}) {
  const {
    solve,
    error,
    setError,
    isRunning,
    allOk,
    checks,
    elementOrder,
    solverMethod,
    setSolverMethod,
    largeDeformation,
    setLargeDeformation,
    loadIncrements,
    setLoadIncrements,
    solverNote,
    logs,
  } = useSolver();
  // The increment count as typed: the store takes it once it is valid.
  const [incrementsDraft, setIncrementsDraft] = useState<string | null>(null);
  const incrementsText = incrementsDraft ?? String(loadIncrements);
  const incrementsValid = isLoadIncrementCount(Number(incrementsText));
  const engine = useEngineGate();
  const text = useT(solveMessages);

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {header}
        {error && (
          <FailureBanner
            notice={error}
            onClose={() => setError(null)}
            testId="solve-error"
          />
        )}
        <PreflightChecks checks={checks} />

        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
          {text.solverSettings}
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>{text.step}</span>
          <span className={styles.statVal}>{text.staticStep(study.name)}</span>
        </div>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>{text.solver}</span>
          <select
            className={styles.formSelect}
            data-testid="solver-method"
            value={solverMethod}
            disabled={isRunning}
            onChange={(e) => {
              if (isSolverMethod(e.target.value))
                setSolverMethod(e.target.value);
            }}
            title={text.solverHint}
          >
            {SOLVER_METHODS.map((method) => (
              <option key={method} value={method}>
                {method === "amg" ? text.methodAmg : text.methodGaussSeidel}
              </option>
            ))}
          </select>
        </div>
        {solverNote !== null && (
          <div className={styles.formNote} data-testid="solver-method-note">
            {solverNote}
          </div>
        )}
        <label className={styles.formRow}>
          <span className={styles.formLabel}>{text.largeDeformation}</span>
          <input
            type="checkbox"
            data-testid="large-deformation"
            checked={largeDeformation}
            disabled={isRunning}
            onChange={(e) => setLargeDeformation(e.target.checked)}
          />
        </label>
        {largeDeformation && (
          <>
            <div className={styles.formRow}>
              <span className={styles.formLabel}>{text.loadIncrements}</span>
              <input
                className={styles.formInput}
                type="number"
                data-testid="load-increments"
                min={1}
                max={MAX_LOAD_INCREMENTS}
                step={1}
                value={incrementsText}
                disabled={isRunning}
                aria-invalid={!incrementsValid}
                onChange={(e) => {
                  const typed = e.target.value;
                  setIncrementsDraft(typed);
                  const count = Number(typed);
                  if (isLoadIncrementCount(count)) setLoadIncrements(count);
                }}
                onBlur={() => setIncrementsDraft(null)}
              />
            </div>
            {!incrementsValid && (
              <p
                className={styles.formNote}
                data-testid="load-increments-invalid"
              >
                {text.loadIncrementsInvalid(MAX_LOAD_INCREMENTS)}
              </p>
            )}
          </>
        )}
        <div className={styles.statRow}>
          <span className={styles.statKey}>{text.output}</span>
          <span className={styles.statVal}>U, S, RF</span>
        </div>
        {/* The element order is set with the mesh controls (issue #286) —
            echoed here read-only so the pre-solve summary stays complete. */}
        <div className={styles.statRow}>
          <span className={styles.statKey}>{text.elementOrder}</span>
          <span className={styles.statVal}>
            {elementOrder === 2 ? text.quadratic : text.linear}
          </span>
        </div>

        <button
          className={styles.solveBtn}
          disabled={!allOk || isRunning || engine.blocked}
          title={engine.reason}
          onClick={solve}
        >
          {isRunning ? text.solving : text.runStaticSolve}
        </button>

        <LogSection logs={logs} busy={isRunning} />
        {footer}
      </div>
    </div>
  );
}

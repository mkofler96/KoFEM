// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import type { Study } from "../../store/modelStore";
import { useSolver } from "../../hooks/useSolver";
import { useEngineGate } from "../../store/engineStore";
import { LogSection } from "./LogSection";
import { PreflightChecks } from "./PreflightChecks";
import { isSolverMethod, SOLVER_METHODS } from "../../lib/solve/amg";
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
    amgUnavailable,
    logs,
  } = useSolver();
  const engine = useEngineGate();

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {header}
        {error && (
          <div className={styles.errorBanner}>
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        <PreflightChecks checks={checks} />

        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
          Solver settings
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Step</span>
          <span className={styles.statVal}>Static · {study.name}</span>
        </div>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>Solver</span>
          <select
            className={styles.formSelect}
            data-testid="solver-method"
            value={solverMethod}
            disabled={isRunning}
            onChange={(e) => {
              if (isSolverMethod(e.target.value))
                setSolverMethod(e.target.value);
            }}
            title="Both solve the same equations to the same accuracy. AMG multigrid needs far fewer iterations on large and thin-walled models."
          >
            {SOLVER_METHODS.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {solverMethod === "amg" && amgUnavailable !== null && (
          <div className={styles.formNote} data-testid="solver-method-note">
            AMG is not available for this model ({amgUnavailable.reason}). It
            will solve with {amgUnavailable.fallback}.
          </div>
        )}
        <div className={styles.statRow}>
          <span className={styles.statKey}>Output</span>
          <span className={styles.statVal}>U, S, RF</span>
        </div>
        {/* The element order is set with the mesh controls (issue #286) —
            echoed here read-only so the pre-solve summary stays complete. */}
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
          disabled={!allOk || isRunning || engine.blocked}
          title={engine.reason}
          onClick={solve}
        >
          {isRunning ? "Solving…" : "▶  Run static solve"}
        </button>

        <LogSection logs={logs} busy={isRunning} />
        {footer}
      </div>
    </div>
  );
}

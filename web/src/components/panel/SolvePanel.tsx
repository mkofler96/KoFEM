// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import type { Study } from "../../store/modelStore";
import { useSolver } from "../../hooks/useSolver";
import { useEngineGate } from "../../store/engineStore";
import { LogSection } from "./LogSection";
import { PreflightChecks } from "./PreflightChecks";
import { isSolverMethod, SOLVER_METHODS } from "../../lib/solve/amg";
import { useT } from "../../i18n/useLocale";
import { solveMessages } from "../../i18n/messages/solve";
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
    solverNote,
    logs,
  } = useSolver();
  const engine = useEngineGate();
  const text = useT(solveMessages);

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

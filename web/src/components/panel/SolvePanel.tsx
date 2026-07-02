// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSolver } from "../../hooks/useSolver";
import styles from "./LeftPanel.module.css";

export function SolvePanel() {
  const { solve, error, setError, isRunning, allOk, checks, elementOrder } =
    useSolver();

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {error && (
          <div className={styles.errorBanner}>
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        <div className={styles.sectionLabel}>Pre-flight check</div>
        {checks.map(([ok, label], i) => (
          <div key={i} className={styles.checkRow}>
            <span className={ok ? styles.checkOk : styles.checkFail}>
              {ok ? "✓" : "✗"}
            </span>
            <span className={styles.checkLabel}>{label}</span>
          </div>
        ))}

        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
          Solver settings
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Step</span>
          <span className={styles.statVal}>Static · Step-1</span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Solver</span>
          <span className={styles.statVal}>Direct</span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statKey}>Output</span>
          <span className={styles.statVal}>U, S, RF</span>
        </div>
        {/* The element order is set with the mesh controls on the Geometry
            tab (issue #286) — echoed here read-only so the pre-solve summary
            stays complete. */}
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
          disabled={!allOk || isRunning}
          onClick={solve}
        >
          {isRunning ? "Solving…" : "▶  Run static solve"}
        </button>
      </div>
    </div>
  );
}

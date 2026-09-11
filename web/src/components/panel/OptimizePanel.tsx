// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import type { TopOptNumericField } from "../../store/modelStore";
import { useTopOpt, type FieldErrors } from "../../hooks/useTopOpt";
import { LogSection } from "./LogSection";
import styles from "./LeftPanel.module.css";

// One labelled numeric setting bound to the store, with its inline validation
// message. The value is the raw text the user typed (parsed and range-checked in
// useTopOpt), so an in-progress edit is never coerced — an invalid field shows
// its error and blocks the run rather than falling back to a default.
function SettingField({
  field,
  label,
  hint,
  errors,
}: {
  field: TopOptNumericField;
  label: string;
  hint?: string;
  errors: FieldErrors;
}) {
  const value = useModelStore((s) => s.topOpt[field]);
  const setTopOptSetting = useModelStore((s) => s.setTopOptSetting);
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
          onChange={(e) => setTopOptSetting(field, e.target.value)}
        />
      </div>
      {err ? (
        <div className={styles.fieldError}>{err}</div>
      ) : (
        hint && <div className={styles.formNote}>{hint}</div>
      )}
    </>
  );
}

export function OptimizePanel() {
  const objective = useModelStore((s) => s.topOpt.objective);
  const setTopOptObjective = useModelStore((s) => s.setTopOptObjective);
  const {
    optimize,
    cancel,
    error,
    setError,
    isOptimizing,
    allOk,
    checks,
    errors,
    logs,
  } = useTopOpt();
  const [advancedOpen, setAdvancedOpen] = useState(false);

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
        {checks.map(([ok, label]) => (
          <div key={label} className={styles.checkRow}>
            <span className={ok ? styles.checkOk : styles.checkFail}>
              {ok ? "✓" : "✗"}
            </span>
            <span className={styles.checkLabel}>{label}</span>
          </div>
        ))}

        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
          Objective
        </div>
        <div className={styles.segToggle}>
          <button
            className={`${styles.segBtn} ${objective === "min_compliance" ? styles.segBtnActive : ""}`}
            onClick={() => setTopOptObjective("min_compliance")}
          >
            Min compliance
          </button>
          <button
            className={`${styles.segBtn} ${objective === "min_volume" ? styles.segBtnActive : ""}`}
            onClick={() => setTopOptObjective("min_volume")}
          >
            Min volume
          </button>
        </div>

        <div className={styles.sectionLabel}>Constraint</div>
        {objective === "min_compliance" ? (
          <SettingField
            field="volumeFraction"
            label="Volume frac."
            hint="Target fraction of material to keep, 0–1 (e.g. 0.5)"
            errors={errors}
          />
        ) : (
          <>
            <SettingField
              field="complianceLimit"
              label="Compliance ≤"
              hint="Upper bound on compliance, in the model's work units"
              errors={errors}
            />
            {/* min_volume shares the KOF-231 contract but its engine loop
                (KOF-235) is not implemented yet — flag it here rather than let
                the run fail with a bare engine error. */}
            <div className={styles.hint}>
              Minimize-volume is not implemented in the solver yet — running it
              will report an error.
            </div>
          </>
        )}

        <div className={styles.sectionLabel}>SIMP parameters</div>
        <SettingField
          field="penalty"
          label="Penalty p"
          hint="SIMP penalization exponent, ≥ 1 (typically 3)"
          errors={errors}
        />
        <SettingField
          field="filterRadius"
          label="Filter r_min"
          hint="Density filter radius, in model length units"
          errors={errors}
        />

        <button
          className={styles.advancedToggle}
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
        >
          <span
            className={`${styles.advancedChevron} ${advancedOpen ? styles.advancedChevronOpen : ""}`}
          >
            ▶
          </span>
          Advanced
        </button>
        {advancedOpen && (
          <>
            <SettingField
              field="moveLimit"
              label="Move limit"
              hint="MMA step cap per iteration, (0, 1] (default 0.2)"
              errors={errors}
            />
            <SettingField
              field="maxIterations"
              label="Max iters"
              hint="Iteration cap (whole number > 0)"
              errors={errors}
            />
            <SettingField
              field="tolerance"
              label="Tolerance"
              hint="Stop when max |Δρ| falls below this (> 0)"
              errors={errors}
            />
          </>
        )}

        <button
          className={styles.solveBtn}
          disabled={!allOk || isOptimizing}
          onClick={optimize}
        >
          {isOptimizing ? "Optimizing…" : "▶  Run optimization"}
        </button>
        {isOptimizing && (
          <button
            className={styles.cancelBtn}
            style={{ width: "100%", marginTop: 8 }}
            onClick={cancel}
          >
            Cancel
          </button>
        )}

        <LogSection logs={logs} busy={isOptimizing} />
      </div>
    </div>
  );
}

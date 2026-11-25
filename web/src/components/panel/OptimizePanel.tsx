// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, type ReactNode } from "react";
import { useModelStore } from "../../store/modelStore";
import type { Study, TopOptNumericField } from "../../store/modelStore";
import { useTopOpt, type FieldErrors } from "../../hooks/useTopOpt";
import { resultUnit } from "../../lib/resultField";
import { LogSection } from "./LogSection";
import { NotConvergedNotice } from "./NotConvergedNotice";
import { PreflightChecks } from "./PreflightChecks";
import { useT } from "../../i18n/useLocale";
import { optimizeMessages } from "../../i18n/messages/optimize";
import styles from "./Panel.module.css";

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

// One optimization study: optimizes the material layout for the supports and
// loads of its static case. `header` / `footer` carry the study's own controls
// (its static case, delete).
export function OptimizePanel({
  staticCase,
  header,
  footer,
}: {
  staticCase: Study | null;
  header: ReactNode;
  footer: ReactNode;
}) {
  const method = useModelStore((s) => s.topOpt.method);
  const objective = useModelStore((s) => s.topOpt.objective);
  const setTopOptMethod = useModelStore((s) => s.setTopOptMethod);
  const setTopOptObjective = useModelStore((s) => s.setTopOptObjective);
  const stressConstraint = useModelStore((s) => s.topOpt.stressConstraint);
  const setStressConstraint = useModelStore((s) => s.setStressConstraint);
  const stressAggregation = useModelStore((s) => s.topOpt.stressAggregation);
  const setStressAggregation = useModelStore((s) => s.setStressAggregation);
  const levelSet = method === "level_set";
  // The max-stress constraint is SIMP-only (KOF-236): its controls are hidden in
  // level-set mode, and useTopOpt neither validates nor sends it there.
  const stressOn = !levelSet && stressConstraint;
  const text = useT(optimizeMessages);
  const {
    optimize,
    cancel,
    error,
    setError,
    isOptimizing,
    allOk: modelOk,
    checks: modelChecks,
    errors,
    logs,
    designDomain,
  } = useTopOpt();
  // Without a static case there is nothing to optimize for.
  const checks: [boolean, string][] = [
    [
      staticCase !== null,
      staticCase ? text.staticCase(staticCase.name) : text.noStaticCase,
    ],
    ...modelChecks,
  ];
  const allOk = modelOk && staticCase !== null;
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // A run that stopped at its iteration limit (KOF-412) offers to run again
  // with a higher one; useTopOpt starts the requested run. The live density
  // and the convergence chart are on Results → Density, where a run goes as
  // it starts.
  const densityResult = useModelStore((s) => s.densityResult);
  const rerunTopOptWithMoreIterations = useModelStore(
    (s) => s.rerunTopOptWithMoreIterations,
  );

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
          {text.designDomain}
        </div>
        <div className={styles.formNote}>{designDomain}</div>

        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
          {text.method}
        </div>
        <div className={styles.segToggle}>
          <button
            className={`${styles.segBtn} ${!levelSet ? styles.segBtnActive : ""}`}
            onClick={() => setTopOptMethod("simp")}
          >
            SIMP
          </button>
          <button
            className={`${styles.segBtn} ${levelSet ? styles.segBtnActive : ""}`}
            onClick={() => setTopOptMethod("level_set")}
          >
            {text.levelSet}
          </button>
        </div>
        <div className={styles.formNote}>
          {levelSet ? text.levelSetNote : text.simpNote}
        </div>

        <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
          {text.objective}
        </div>
        <div className={styles.segToggle}>
          <button
            className={`${styles.segBtn} ${objective === "min_compliance" ? styles.segBtnActive : ""}`}
            onClick={() => setTopOptObjective("min_compliance")}
          >
            {text.minCompliance}
          </button>
          <button
            className={`${styles.segBtn} ${objective === "min_volume" ? styles.segBtnActive : ""}`}
            onClick={() => setTopOptObjective("min_volume")}
          >
            {text.minVolume}
          </button>
        </div>

        <div className={styles.sectionLabel}>{text.constraint}</div>
        {objective === "min_compliance" ? (
          <SettingField
            field="volumeFraction"
            label={text.volumeFraction}
            hint={text.volumeFractionHint}
            errors={errors}
          />
        ) : (
          <SettingField
            field="complianceLimit"
            label={text.complianceLimit}
            hint={stressOn ? text.complianceStressHint : text.complianceHint}
            errors={errors}
          />
        )}

        {!levelSet && (
          <label className={styles.formRow}>
            <input
              type="checkbox"
              data-testid="topopt-stress-constraint"
              checked={stressConstraint}
              onChange={(e) => setStressConstraint(e.target.checked)}
            />
            <span className={styles.bodyLabel}>{text.maxStressConstraint}</span>
          </label>
        )}
        {stressOn && (
          <SettingField
            field="maxStress"
            label="σ_vm ≤"
            hint={text.maxStressHint(resultUnit("Von Mises stress"))}
            errors={errors}
          />
        )}

        {levelSet ? (
          <>
            <div className={styles.sectionLabel}>{text.levelSetParameters}</div>
            <SettingField
              field="filterRadius"
              label={text.lengthScale}
              hint={text.lengthScaleHint}
              errors={errors}
            />
          </>
        ) : (
          <>
            <div className={styles.sectionLabel}>{text.simpParameters}</div>
            <SettingField
              field="penalty"
              label={text.penalty}
              hint={text.penaltyHint}
              errors={errors}
            />
            <SettingField
              field="filterRadius"
              label={text.filterRadius}
              hint={text.filterRadiusHint}
              errors={errors}
            />
          </>
        )}

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
          {text.advanced}
        </button>
        {advancedOpen && (
          <>
            {!levelSet && (
              <SettingField
                field="moveLimit"
                label={text.moveLimit}
                hint={text.moveLimitHint}
                errors={errors}
              />
            )}
            <SettingField
              field="maxIterations"
              label={text.maxIterations}
              hint={text.maxIterationsHint}
              errors={errors}
            />
            <SettingField
              field="tolerance"
              label={text.tolerance}
              hint={text.toleranceHint}
              errors={errors}
            />
            {stressOn && (
              <>
                <div className={styles.formRow}>
                  <label className={styles.formLabel}>{text.aggregation}</label>
                  <div className={styles.segToggle}>
                    <button
                      className={`${styles.segBtn} ${stressAggregation === "pnorm" ? styles.segBtnActive : ""}`}
                      onClick={() => setStressAggregation("pnorm")}
                    >
                      P-norm
                    </button>
                    <button
                      className={`${styles.segBtn} ${stressAggregation === "ks" ? styles.segBtnActive : ""}`}
                      onClick={() => setStressAggregation("ks")}
                    >
                      KS
                    </button>
                  </div>
                </div>
                <SettingField
                  field="stressP"
                  label={text.aggregationP}
                  hint={
                    stressAggregation === "pnorm" ? text.pNormHint : text.ksHint
                  }
                  errors={errors}
                />
              </>
            )}
          </>
        )}

        {densityResult && !isOptimizing && (
          <NotConvergedNotice
            run={densityResult}
            onRerun={rerunTopOptWithMoreIterations}
          />
        )}

        <button
          className={styles.solveBtn}
          disabled={!allOk || isOptimizing}
          onClick={optimize}
        >
          {isOptimizing ? text.optimizing : text.runOptimization}
        </button>
        {isOptimizing && (
          <button
            className={styles.cancelBtn}
            style={{ width: "100%", marginTop: 8 }}
            onClick={cancel}
          >
            {text.cancel}
          </button>
        )}

        <LogSection logs={logs} busy={isOptimizing} />
        {footer}
      </div>
    </div>
  );
}

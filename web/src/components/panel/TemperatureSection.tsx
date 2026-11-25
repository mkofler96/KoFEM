// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The model's temperature change (KOF-449): ΔT in °C from the stress-free
// state, a formula in x, y and z (mm) that the solve evaluates at every node.
// The formula is checked by the Rust module's parser as the user types, so a
// typo shows here rather than at the solve.

import { useEffect, useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { loadFemModule } from "../../lib/femModule";
import { checkFieldExpression } from "../../wasm/fem/kofem_wasm.js";
import { useT } from "../../i18n/useLocale";
import { boundaryMessages } from "../../i18n/messages/boundary";
import styles from "./Panel.module.css";

// The parser's verdict on a formula: null when it parses, else its message.
function useFormulaCheck(formula: string): string | null | "pending" {
  const [verdict, setVerdict] = useState<string | null | "pending">("pending");
  useEffect(() => {
    let live = true;
    setVerdict("pending");
    loadFemModule().then(
      () => {
        if (!live) return;
        try {
          checkFieldExpression(formula);
          setVerdict(null);
        } catch (err) {
          setVerdict(err instanceof Error ? err.message : String(err));
        }
      },
      (err: unknown) =>
        live && setVerdict(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [formula]);
  return verdict;
}

export function TemperatureSection() {
  const temperature = useModelStore((s) => s.temperature);
  const setTemperature = useModelStore((s) => s.setTemperature);
  const [formula, setFormula] = useState(
    temperature === null ? "" : temperature.formula,
  );
  const blank = formula.trim() === "";
  const verdict = useFormulaCheck(blank ? "0" : formula);
  const usable = !blank && verdict === null;
  const text = useT(boundaryMessages);
  return (
    <div data-testid="temperature-section">
      <div className={styles.sectionLabel}>{text.kindTemperature}</div>
      <div className={`${styles.formNote} ${styles.formNoteFull}`}>
        {text.temperatureNote}
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>ΔT (°C)</span>
        <input
          className={styles.formInput}
          data-testid="temperature-formula"
          aria-label={text.temperatureFormula}
          placeholder={text.temperaturePlaceholder}
          value={formula}
          onChange={(e) => setFormula(e.target.value)}
        />
      </div>
      {!blank && typeof verdict === "string" && verdict !== "pending" && (
        <div className={styles.formNote} data-testid="temperature-error">
          {verdict}
        </div>
      )}
      <div className={styles.formBtns}>
        {temperature !== null && (
          <button
            className={styles.cancelBtn}
            data-testid="temperature-remove"
            onClick={() => {
              setTemperature(null);
              setFormula("");
            }}
          >
            {text.remove}
          </button>
        )}
        <button
          className={styles.primaryBtn}
          data-testid="temperature-apply"
          disabled={!usable}
          onClick={() => setTemperature(formula)}
        >
          {text.apply}
        </button>
      </div>
      {temperature !== null && (
        <div className={styles.formNote} data-testid="temperature-applied">
          {text.temperatureApplied(temperature.formula)}
        </div>
      )}
    </div>
  );
}

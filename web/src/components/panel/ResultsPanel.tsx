// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore, RESULT_TYPES } from "../../store/modelStore";
import type { ResultType } from "../../store/modelStore";
import {
  computeResultRange,
  resultFieldSymbol,
  resultUnit,
} from "../../lib/resultField";
import styles from "./LeftPanel.module.css";

export function ResultsPanel() {
  const result = useModelStore((s) => s.result);
  const resultType = useModelStore((s) => s.resultType);
  const setResultType = useModelStore((s) => s.setResultType);
  const deformScale = useModelStore((s) => s.deformScale);
  const setDeformScale = useModelStore((s) => s.setDeformScale);
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);

  if (!result) {
    return (
      <div className={styles.panel}>
        <div className={styles.tabContent}>
          <div className={styles.empty}>No results — run the solver first</div>
        </div>
      </div>
    );
  }

  // Min/max of the selected scalar field over all nodes — the same field and
  // node averaging used for the viewport coloring and colorbar legend.
  const stats = computeResultRange(result, resultType, nodes, elements);

  const fieldSymbol = resultFieldSymbol(resultType);
  const unit = resultUnit(resultType);

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        <div className={styles.sectionLabel}>Field</div>
        <select
          className={styles.formSelect}
          style={{ marginBottom: 12 }}
          value={resultType}
          onChange={(e) => setResultType(e.target.value as ResultType)}
        >
          {RESULT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <div className={styles.sectionLabel}>Deformation scale</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 12,
          }}
        >
          <input
            type="range"
            min={0}
            max={3}
            step={0.05}
            value={deformScale}
            onChange={(e) => setDeformScale(parseFloat(e.target.value))}
            style={{ flex: 1 }}
            aria-label="Deformation scale"
          />
          <span
            className={styles.statVal}
            style={{ minWidth: 38, textAlign: "right" }}
          >
            {deformScale.toFixed(2)}×
          </span>
        </div>

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
            {resultType === "Von Mises stress"
              ? "Von Mises data not available — re-run the solver"
              : "No nodal data"}
          </div>
        )}
      </div>
    </div>
  );
}

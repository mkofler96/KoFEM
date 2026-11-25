// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import { visibleElementCount } from "../../lib/densityField";
import { useT } from "../../i18n/useLocale";
import { resultsMessages } from "../../i18n/messages/results";
import styles from "./Panel.module.css";

// The density threshold slider that filters the viewport's density field, plus
// the visible-element readout for `density`. Shared by the Results view of a
// finished run (KOF-233) and the Optimize panel during a run (KOF-240), so the
// cutoff the user sets while watching the shape emerge carries into Results.
export function DensityThresholdControl({
  density,
}: {
  density: Float64Array;
}) {
  const threshold = useModelStore((s) => s.densityThreshold);
  const setDensityThreshold = useModelStore((s) => s.setDensityThreshold);
  const smooth = useModelStore((s) => s.densitySmooth);
  const setDensitySmooth = useModelStore((s) => s.setDensitySmooth);
  const visible = visibleElementCount(density, threshold);
  const text = useT(resultsMessages);

  return (
    <>
      <div className={styles.sectionLabel}>{text.densityThreshold}</div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={threshold}
          onChange={(e) => setDensityThreshold(parseFloat(e.target.value))}
          style={{ flex: 1 }}
          aria-label={text.densityThreshold}
        />
        <span
          className={styles.statVal}
          style={{ minWidth: 38, textAlign: "right" }}
        >
          {threshold.toFixed(2)}
        </span>
      </div>
      <div className={styles.formNote} style={{ marginBottom: 8 }}>
        {smooth ? text.smoothNote : text.elementsNote}
      </div>
      <div className={styles.segToggle} style={{ marginBottom: 12 }}>
        <button
          className={`${styles.segBtn} ${smooth ? styles.segBtnActive : ""}`}
          onClick={() => setDensitySmooth(true)}
        >
          {text.smooth}
        </button>
        <button
          className={`${styles.segBtn} ${!smooth ? styles.segBtnActive : ""}`}
          onClick={() => setDensitySmooth(false)}
        >
          {text.elements}
        </button>
      </div>
      <div className={styles.statRow}>
        <span className={styles.statKey}>{text.visibleElements}</span>
        <span className={styles.statVal} data-testid="visible-element-count">
          {visible} / {density.length}
        </span>
      </div>
    </>
  );
}

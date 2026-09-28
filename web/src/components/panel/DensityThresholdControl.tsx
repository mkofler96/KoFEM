// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../../store/modelStore";
import { visibleElementCount } from "../../lib/densityField";
import styles from "./LeftPanel.module.css";

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

  return (
    <>
      <div className={styles.sectionLabel}>Density threshold</div>
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
          aria-label="Density threshold"
        />
        <span
          className={styles.statVal}
          style={{ minWidth: 38, textAlign: "right" }}
        >
          {threshold.toFixed(2)}
        </span>
      </div>
      <div className={styles.formNote} style={{ marginBottom: 8 }}>
        {smooth
          ? "Shows the surface where the density crosses the cutoff (the level set's own boundary at 0.50)."
          : "Elements below the cutoff are hidden, revealing the optimized shape."}
      </div>
      <div className={styles.segToggle} style={{ marginBottom: 12 }}>
        <button
          className={`${styles.segBtn} ${smooth ? styles.segBtnActive : ""}`}
          onClick={() => setDensitySmooth(true)}
        >
          Smooth
        </button>
        <button
          className={`${styles.segBtn} ${!smooth ? styles.segBtnActive : ""}`}
          onClick={() => setDensitySmooth(false)}
        >
          Elements
        </button>
      </div>
      <div className={styles.statRow}>
        <span className={styles.statKey}>Visible elements</span>
        <span className={styles.statVal} data-testid="visible-element-count">
          {visible} / {density.length}
        </span>
      </div>
    </>
  );
}

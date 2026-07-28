// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Manual colorbar limits for the displayed result field (#390). Editing either
// limit pins both; "Auto" hands the range back to the field's own min/max.

import { useEffect, useState } from "react";
import { useModelStore } from "../../store/modelStore";
import type { ResultRange } from "../../lib/resultField";
import styles from "./LeftPanel.module.css";

interface LegendRangeControlsProps {
  // The field's own min/max, used both as the auto range and as the starting
  // point when the user pins the limits.
  fieldRange: ResultRange;
  unit: string;
}

// Short enough to edit by hand, precise enough to not visibly move the limits.
function format(v: number): string {
  return String(Number(v.toPrecision(4)));
}

export function LegendRangeControls({
  fieldRange,
  unit,
}: LegendRangeControlsProps) {
  const legendRange = useModelStore((s) => s.legendRange);
  const setLegendRange = useModelStore((s) => s.setLegendRange);
  const active = legendRange ?? fieldRange;

  const [minText, setMinText] = useState(() => format(active.min));
  const [maxText, setMaxText] = useState(() => format(active.max));
  const [error, setError] = useState<string | null>(null);

  // The active range changes under the inputs whenever the user switches result
  // type or a new solve lands (both clear the override) — follow it.
  useEffect(() => {
    setMinText(format(active.min));
    setMaxText(format(active.max));
    setError(null);
  }, [active.min, active.max]);

  const apply = () => {
    const min = Number(minText);
    const max = Number(maxText);
    if (
      minText.trim() === "" ||
      maxText.trim() === "" ||
      Number.isNaN(min) ||
      Number.isNaN(max)
    ) {
      setError("Both limits must be numbers");
      return;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      setError("Limits must be finite");
      return;
    }
    if (max <= min) {
      setError("Max must be greater than min");
      return;
    }
    setError(null);
    setLegendRange({ min, max });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  };

  return (
    <>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Min</span>
        <input
          className={styles.formInput}
          data-testid="legend-min"
          type="number"
          value={minText}
          onChange={(e) => setMinText(e.target.value)}
          onBlur={apply}
          onKeyDown={onKeyDown}
          aria-label="Legend minimum"
        />
        <span className={styles.toleranceUnit}>{unit}</span>
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Max</span>
        <input
          className={styles.formInput}
          data-testid="legend-max"
          type="number"
          value={maxText}
          onChange={(e) => setMaxText(e.target.value)}
          onBlur={apply}
          onKeyDown={onKeyDown}
          aria-label="Legend maximum"
        />
        <span className={styles.toleranceUnit}>{unit}</span>
      </div>
      {error && (
        <div className={styles.formNote} data-testid="legend-error">
          {error}
        </div>
      )}
      <div className={styles.formNote}>
        {legendRange
          ? "Values outside the range take the end colours."
          : "Auto: the field's own min/max."}
      </div>
      <button
        className={styles.outlineBtn}
        data-testid="legend-auto"
        style={{ marginBottom: 12 }}
        disabled={!legendRange}
        onClick={() => {
          setLegendRange(null);
          setError(null);
        }}
      >
        Auto
      </button>
    </>
  );
}

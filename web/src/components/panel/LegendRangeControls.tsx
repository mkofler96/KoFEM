// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Manual colorbar limits for the displayed result field (#390), in the popup
// the legend's pencil opens. Editing either limit pins both; "Auto", shown
// beside the heading while they are pinned, hands the range back to the
// field's own min/max.
// A valid pair applies as the user types (KOF-384); an invalid one is reported
// on Enter or blur only, so partial input ("-", "") never flashes an error.

import { useEffect, useRef, useState } from "react";
import { useModelStore } from "../../store/modelStore";
import type { ResultRange } from "../../lib/resultField";
import { useT } from "../../i18n/useLocale";
import { resultsMessages } from "../../i18n/messages/results";
import styles from "./Panel.module.css";

interface LegendRangeControlsProps {
  // The field's own min/max, used both as the auto range and as the starting
  // point when the user pins the limits.
  fieldRange: ResultRange;
  unit: string;
  // Closes the popup these controls sit in.
  onClose: () => void;
}

type LimitError = "limitsNotNumbers" | "limitsNotFinite" | "maxNotAboveMin";
type Parsed = { range: ResultRange } | { error: LimitError };

function parse(minText: string, maxText: string): Parsed {
  const min = Number(minText);
  const max = Number(maxText);
  if (
    minText.trim() === "" ||
    maxText.trim() === "" ||
    Number.isNaN(min) ||
    Number.isNaN(max)
  ) {
    return { error: "limitsNotNumbers" };
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { error: "limitsNotFinite" };
  }
  if (max <= min) return { error: "maxNotAboveMin" };
  return { range: { min, max } };
}

// Short enough to edit by hand, precise enough to not visibly move the limits.
function format(v: number): string {
  return String(Number(v.toPrecision(4)));
}

export function LegendRangeControls({
  fieldRange,
  unit,
  onClose,
}: LegendRangeControlsProps) {
  const legendRange = useModelStore((s) => s.legendRange);
  const setLegendRange = useModelStore((s) => s.setLegendRange);
  const active = legendRange ?? fieldRange;

  const [minText, setMinText] = useState(() => format(active.min));
  const [maxText, setMaxText] = useState(() => format(active.max));
  const [error, setError] = useState<LimitError | null>(null);
  const text = useT(resultsMessages);

  // The range this control last applied from the user's own text. Its echo
  // through the store must not rewrite the text under the cursor.
  const applied = useRef<ResultRange | null>(null);

  // The active range changes under the inputs whenever the user switches result
  // type or a new solve lands (both clear the override) — follow it.
  useEffect(() => {
    const own = applied.current;
    if (own !== null && own.min === active.min && own.max === active.max) {
      return;
    }
    applied.current = null;
    setMinText(format(active.min));
    setMaxText(format(active.max));
    setError(null);
  }, [active.min, active.max]);

  const commit = (range: ResultRange) => {
    applied.current = range;
    setLegendRange(range);
  };

  // Enter and blur: apply, or report the problem right away.
  const apply = () => {
    const parsed = parse(minText, maxText);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    commit(parsed.range);
  };

  // Typing: apply a valid pair at once and keep the last valid range
  // otherwise; a half-typed number is not an error until Enter or blur.
  const edit = (nextMin: string, nextMax: string) => {
    setMinText(nextMin);
    setMaxText(nextMax);
    setError(null);
    const parsed = parse(nextMin, nextMax);
    if ("range" in parsed) commit(parsed.range);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
    }
  };

  // The text follows at once, not a frame later through the effect above:
  // typed in that frame, an edit would be checked against the old text.
  const auto = () => {
    applied.current = null;
    setLegendRange(null);
    setMinText(format(fieldRange.min));
    setMaxText(format(fieldRange.max));
    setError(null);
  };

  return (
    <>
      <div className={styles.sectionHead}>
        <span className={styles.sectionLabel} id="legend-range-title">
          {text.legendRange}
        </span>
        <span style={{ display: "inline-flex", gap: 10 }}>
          {legendRange && (
            <button
              className={styles.sectionHeadAction}
              data-testid="legend-auto"
              title={text.useFieldRange}
              onClick={auto}
            >
              {text.auto}
            </button>
          )}
          <button
            className={styles.iconBtn}
            data-testid="legend-close"
            aria-label={text.close}
            title={text.close}
            onClick={onClose}
          >
            ✕
          </button>
        </span>
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{text.min}</span>
        <input
          className={styles.formInput}
          data-testid="legend-min"
          type="number"
          value={minText}
          onChange={(e) => edit(e.target.value, maxText)}
          onBlur={apply}
          onKeyDown={onKeyDown}
          aria-label={text.legendMinimum}
        />
        <span className={styles.toleranceUnit}>{unit}</span>
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{text.max}</span>
        <input
          className={styles.formInput}
          data-testid="legend-max"
          type="number"
          value={maxText}
          onChange={(e) => edit(minText, e.target.value)}
          onBlur={apply}
          onKeyDown={onKeyDown}
          aria-label={text.legendMaximum}
        />
        <span className={styles.toleranceUnit}>{unit}</span>
      </div>
      {error && (
        <div className={styles.formNote} data-testid="legend-error">
          {text[error]}
        </div>
      )}
      {legendRange && (
        <div className={styles.formNote}>{text.outsideRange}</div>
      )}
    </>
  );
}

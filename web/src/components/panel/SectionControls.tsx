// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A result plot's section cut (KOF-390), the panel of its row under the plot:
// cut the model along x, y or z to see the field inside it. A slider places the
// plane across the model, Flip keeps the other side, and the min and max on the
// cut can be shown. The legend keeps referring to the whole model.

import { useModelStore } from "../../store/modelStore";
import type { ResultSection, ResultType } from "../../store/modelStore";
import { resultFieldSymbol, resultUnit } from "../../lib/resultField";
import styles from "./Panel.module.css";

const AXES = ["x", "y", "z"] as const;

export function SectionControls({
  plotId,
  section,
  field,
}: {
  plotId: number;
  section: ResultSection;
  field: ResultType;
}) {
  const setPlotSection = useModelStore((s) => s.setPlotSection);
  const showRange = useModelStore((s) => s.showSectionRange);
  const setShowRange = useModelStore((s) => s.setShowSectionRange);
  const range = useModelStore((s) => s.sectionRange);
  const error = useModelStore((s) => s.sectionError);
  const symbol = resultFieldSymbol(field);
  const unit = resultUnit(field);

  const update = (change: Partial<ResultSection>) =>
    setPlotSection(plotId, { ...section, ...change });

  return (
    <>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Along</span>
        <select
          className={styles.formSelect}
          data-testid="section-axis"
          aria-label="Section axis"
          value={AXES[section.axis]}
          onChange={(e) =>
            update({
              axis: AXES.indexOf(
                e.target.value as (typeof AXES)[number],
              ) as ResultSection["axis"],
            })
          }
        >
          {AXES.map((name) => (
            <option key={name} value={name}>
              {name.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.sliderRow}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={section.position}
          onChange={(e) => update({ position: Number(e.target.value) })}
          style={{ flex: 1, minWidth: 0 }}
          aria-label="Section position"
        />
        <button
          className={styles.outlineBtn}
          data-testid="section-flip"
          aria-pressed={section.flipped}
          onClick={() => update({ flipped: !section.flipped })}
          style={{ width: "auto", marginTop: 0 }}
        >
          Flip
        </button>
      </div>
      {error && (
        <div className={styles.fieldError} data-testid="section-error">
          The section cannot be drawn: {error}
        </div>
      )}
      <label className={styles.statRow} style={{ justifyContent: "start" }}>
        <input
          type="checkbox"
          data-testid="section-range"
          checked={showRange}
          onChange={(e) => setShowRange(e.target.checked)}
        />
        <span className={styles.statKey} style={{ marginLeft: 6 }}>
          Show min and max on the cut
        </span>
      </label>
      {showRange &&
        (range ? (
          (["min", "max"] as const).map((end) => (
            <div className={styles.statRow} key={end}>
              <span className={styles.statKey}>
                {end === "min" ? "Min" : "Max"} {symbol} on the cut
              </span>
              <span
                className={styles.statVal}
                data-testid={`section-${end}`}
                data-value={range[end]}
              >
                {range[end].toExponential(3)} {unit}
              </span>
            </div>
          ))
        ) : (
          <div className={styles.formNote}>
            The plane does not cut the model.
          </div>
        ))}
      <button
        className={styles.dangerLink}
        data-testid="delete-section"
        onClick={() => setPlotSection(plotId, null)}
      >
        Delete section cut
      </button>
    </>
  );
}

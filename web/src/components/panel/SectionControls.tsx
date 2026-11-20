// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Section plane of the result view (KOF-390): cut the model along x, y or z
// to see the field inside it. A slider places the plane across the model, Flip
// keeps the other side, and the min and max on the cut can be shown. The
// legend keeps referring to the whole model.

import { useModelStore } from "../../store/modelStore";
import type { ResultSection, ResultType } from "../../store/modelStore";
import { resultFieldSymbol, resultUnit } from "../../lib/resultField";
import styles from "./Panel.module.css";

const AXES = ["x", "y", "z"] as const;

// Where a new section starts: through the middle of the model, keeping the
// part below the plane. A section already set keeps its own position and flip
// when its axis changes.
const NEW_SECTION = { position: 0.5, flipped: false };

export function SectionControls({ field }: { field: ResultType }) {
  const section = useModelStore((s) => s.section);
  const setSection = useModelStore((s) => s.setSection);
  const showRange = useModelStore((s) => s.showSectionRange);
  const setShowRange = useModelStore((s) => s.setShowSectionRange);
  const range = useModelStore((s) => s.sectionRange);
  const error = useModelStore((s) => s.sectionError);
  const symbol = resultFieldSymbol(field);
  const unit = resultUnit(field);

  const update = (change: Partial<ResultSection>) => {
    if (!section) return;
    setSection({ ...section, ...change });
  };

  return (
    <>
      <div className={styles.sectionLabel}>Section</div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Cut</span>
        <select
          className={styles.formSelect}
          data-testid="section-axis"
          aria-label="Section"
          value={section ? AXES[section.axis] : "off"}
          onChange={(e) => {
            const axis = AXES.indexOf(e.target.value as (typeof AXES)[number]);
            setSection(
              axis < 0
                ? null
                : {
                    axis: axis as 0 | 1 | 2,
                    position: section ? section.position : NEW_SECTION.position,
                    flipped: section ? section.flipped : NEW_SECTION.flipped,
                  },
            );
          }}
        >
          <option value="off">Off</option>
          {AXES.map((name) => (
            <option key={name} value={name}>
              Along {name.toUpperCase()}
            </option>
          ))}
        </select>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={section ? section.position : NEW_SECTION.position}
          disabled={!section}
          onChange={(e) => update({ position: Number(e.target.value) })}
          style={{ flex: 1, minWidth: 0 }}
          aria-label="Section position"
        />
        <button
          className={styles.outlineBtn}
          data-testid="section-flip"
          aria-pressed={section ? section.flipped : NEW_SECTION.flipped}
          disabled={!section}
          onClick={() => section && update({ flipped: !section.flipped })}
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
      {section && (
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
      )}
      {section &&
        showRange &&
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
      <div style={{ marginBottom: 12 }} />
    </>
  );
}

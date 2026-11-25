// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Deformation scale of the result view (KOF-383): the real factor the
// displacements are drawn at, in one number box beside a log slider. 1 is true
// scale; clearing the box returns to the automatic factor. A valid factor applies
// as the user types; an invalid one is reported on Enter or blur.

import { useEffect, useRef, useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { useDeformFactor } from "../../hooks/useDeformFactor";
import {
  AUTO_DEFORM_SCALE,
  DEFORM_SLIDER_STEP,
  deformSliderMax,
  factorToSlider,
  formatDeformFactor,
  parseDeformFactor,
  sliderToFactor,
  type DeformFactorError,
} from "../../lib/deformScale";
import { useT } from "../../i18n/useLocale";
import { resultsMessages } from "../../i18n/messages/results";
import styles from "./Panel.module.css";

export function DeformScaleControl() {
  const setDeformScale = useModelStore((s) => s.setDeformScale);
  const { factor, autoFactor, scale } = useDeformFactor();
  const isAuto = scale.mode === "auto";
  const isTrue = scale.mode === "manual" && scale.factor === 1;

  const [entry, setEntry] = useState(() => String(factor));
  const [error, setError] = useState<DeformFactorError | null>(null);
  const text = useT(resultsMessages);
  // The factor this control last applied from the user's own text. Its echo
  // through the store must not rewrite the text under the cursor.
  const applied = useRef<number | null>(null);

  useEffect(() => {
    if (applied.current === factor) return;
    applied.current = null;
    setEntry(String(factor));
    setError(null);
  }, [factor]);

  const setManual = (next: number) => {
    setError(null);
    setDeformScale({ mode: "manual", factor: next });
  };

  const edit = (next: string) => {
    setEntry(next);
    setError(null);
    const parsed = parseDeformFactor(next);
    if ("factor" in parsed) {
      applied.current = parsed.factor;
      setDeformScale({ mode: "manual", factor: parsed.factor });
    }
  };

  // Enter and blur: an empty box hands the factor back to the automatic
  // one; anything else that is not a factor is reported.
  const apply = () => {
    if (entry.trim() === "") {
      applied.current = null;
      setError(null);
      setEntry(String(autoFactor));
      setDeformScale(AUTO_DEFORM_SCALE);
      return;
    }
    const parsed = parseDeformFactor(entry);
    if ("error" in parsed) setError(parsed.error);
  };

  const sliderMax = deformSliderMax(autoFactor);
  const note = isAuto
    ? text.noteAuto
    : factor === 0
      ? text.noteUndeformed
      : isTrue
        ? text.noteTrueScale
        : "";

  return (
    <>
      <div className={styles.sectionLabel}>{text.deformationScale}</div>
      <div className={styles.sliderRow}>
        <input
          type="range"
          min={0}
          max={sliderMax}
          step={DEFORM_SLIDER_STEP}
          value={factorToSlider(factor, sliderMax)}
          onChange={(e) => setManual(sliderToFactor(Number(e.target.value)))}
          style={{ flex: 1, minWidth: 0 }}
          aria-label={text.deformationScale}
          aria-valuetext={`×${formatDeformFactor(factor)}${note}`}
        />
        <span className={styles.sliderRowUnit}>×</span>
        <input
          className={`${styles.formInput} ${styles.sliderRowInput}`}
          data-testid="deform-scale-input"
          type="number"
          min={0}
          value={entry}
          onChange={(e) => edit(e.target.value)}
          onBlur={apply}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
          aria-label={text.deformationFactor}
          title={text.clearForAuto}
          aria-invalid={error !== null}
        />
      </div>
      {error && (
        <div className={styles.fieldError} data-testid="deform-scale-error">
          {text[error]}
        </div>
      )}
    </>
  );
}

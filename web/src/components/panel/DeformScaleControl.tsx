// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Deformation scale of the result view (KOF-383): shows the real factor the
// displacements are drawn at, "×1 240 (auto)", and sets it by a log slider,
// a typed factor, or the Auto and True scale presets. A valid factor applies
// as the user types; an invalid one is reported on Enter or blur.

import { useEffect, useRef, useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { useDeformFactor } from "../../hooks/useDeformFactor";
import {
  AUTO_DEFORM_SCALE,
  DEFORM_SLIDER_STEP,
  TRUE_DEFORM_SCALE,
  deformSliderMax,
  factorToSlider,
  formatDeformFactor,
  parseDeformFactor,
  sliderToFactor,
} from "../../lib/deformScale";
import styles from "./Panel.module.css";

export function DeformScaleControl() {
  const setDeformScale = useModelStore((s) => s.setDeformScale);
  const { factor, autoFactor, scale } = useDeformFactor();
  const isAuto = scale.mode === "auto";
  const isTrue = scale.mode === "manual" && scale.factor === 1;

  const [text, setText] = useState(() => String(factor));
  const [error, setError] = useState<string | null>(null);
  // The factor this control last applied from the user's own text. Its echo
  // through the store must not rewrite the text under the cursor.
  const applied = useRef<number | null>(null);

  useEffect(() => {
    if (applied.current === factor) return;
    applied.current = null;
    setText(String(factor));
    setError(null);
  }, [factor]);

  const setManual = (next: number) => {
    setError(null);
    setDeformScale({ mode: "manual", factor: next });
  };

  const edit = (next: string) => {
    setText(next);
    setError(null);
    const parsed = parseDeformFactor(next);
    if ("factor" in parsed) {
      applied.current = parsed.factor;
      setDeformScale({ mode: "manual", factor: parsed.factor });
    }
  };

  const apply = () => {
    const parsed = parseDeformFactor(text);
    if ("error" in parsed) setError(parsed.error);
  };

  const preset = (auto: boolean) => {
    applied.current = null;
    setError(null);
    setText(String(auto ? autoFactor : 1));
    setDeformScale(auto ? AUTO_DEFORM_SCALE : TRUE_DEFORM_SCALE);
  };

  const sliderMax = deformSliderMax(autoFactor);
  const note = isAuto
    ? " (auto)"
    : factor === 0
      ? " (undeformed)"
      : isTrue
        ? " (true scale)"
        : "";
  const readout = `×${formatDeformFactor(factor)}${note}`;

  return (
    <>
      <div className={styles.sectionLabel}>Deformation scale</div>
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
          max={sliderMax}
          step={DEFORM_SLIDER_STEP}
          value={factorToSlider(factor, sliderMax)}
          onChange={(e) => setManual(sliderToFactor(Number(e.target.value)))}
          style={{ flex: 1, minWidth: 0 }}
          aria-label="Deformation scale"
          aria-valuetext={readout}
        />
        <span
          className={styles.statVal}
          style={{ textAlign: "right", whiteSpace: "nowrap" }}
          data-testid="deform-scale-value"
        >
          {readout}
        </span>
      </div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Factor</span>
        <input
          className={styles.formInput}
          data-testid="deform-scale-input"
          type="number"
          min={0}
          value={text}
          onChange={(e) => edit(e.target.value)}
          onBlur={apply}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
          aria-label="Deformation factor"
          aria-invalid={error !== null}
        />
      </div>
      {error && (
        <div className={styles.fieldError} data-testid="deform-scale-error">
          {error}
        </div>
      )}
      <div className={styles.segToggle} style={{ marginBottom: 12 }}>
        <button
          className={`${styles.segBtn} ${isAuto ? styles.segBtnActive : ""}`}
          data-testid="deform-scale-auto"
          aria-pressed={isAuto}
          onClick={() => preset(true)}
        >
          Auto
        </button>
        <button
          className={`${styles.segBtn} ${isTrue ? styles.segBtnActive : ""}`}
          data-testid="deform-scale-true"
          aria-pressed={isTrue}
          onClick={() => preset(false)}
        >
          True scale
        </button>
      </div>
    </>
  );
}

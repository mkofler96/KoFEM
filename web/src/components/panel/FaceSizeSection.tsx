// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { faceListLabel } from "../../lib/faceSizes";
import { useT } from "../../i18n/useLocale";
import { meshMessages } from "../../i18n/messages/mesh";
import { geometryMessages } from "../../i18n/messages/geometry";
import styles from "./Panel.module.css";

// Element sizes on selected CAD faces (KOF-394), in the Mesh settings: pick
// faces in the view, type a size, Set size. Each entry lists its faces and
// size, which stays editable until the next mesh applies it.
export function FaceSizeSection({ disabled }: { disabled: boolean }) {
  const faceSizes = useModelStore((s) => s.faceSizes);
  const picking = useModelStore((s) => s.faceSizePicking);
  const pickedIds = useModelStore((s) => s.faceSizePickIds);
  const canPick = useModelStore((s) => s.stepSurface?.faceIds !== undefined);
  const setPicking = useModelStore((s) => s.setFaceSizePicking);
  const addFaceSize = useModelStore((s) => s.addFaceSize);
  const removeFaceSize = useModelStore((s) => s.removeFaceSize);
  const toggleFaceSizePick = useModelStore((s) => s.toggleFaceSizePick);
  const text = useT(meshMessages);
  const geometryText = useT(geometryMessages);
  const [size, setSize] = useState("");

  return (
    <div data-testid="face-sizes">
      <div className={styles.sectionLabel}>{text.faceSizes}</div>
      <div className={styles.hint}>{text.faceSizesHint}</div>
      {faceSizes.map((entry, index) => {
        const faces = faceListLabel(entry.faceIds);
        return (
          <div
            key={entry.faceIds.join(",")}
            className={styles.bcFaceRow}
            data-testid={`face-size-${index}`}
          >
            <span className={styles.bcFaceName}>
              {faces}: {text.maxSize(entry.size)}
            </span>
            <button
              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
              data-testid={`face-size-remove-${index}`}
              disabled={disabled}
              title={text.removeFaceSize(faces)}
              aria-label={text.removeFaceSize(faces)}
              onClick={() => removeFaceSize(index)}
            >
              ×
            </button>
          </div>
        );
      })}
      {picking ? (
        <>
          <div className={styles.pickHint} data-testid="face-size-picked">
            {pickedIds.length > 0
              ? text.facesPicked(pickedIds.length)
              : text.clickFacesToPick}
          </div>
          {pickedIds.map((id) => (
            <div
              key={id}
              className={styles.bcFaceRow}
              data-testid={`face-size-pick-${id}`}
            >
              <span className={styles.bcFaceName}>
                {geometryText.faceName(id)}
              </span>
              <button
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                title={geometryText.removeFace}
                onClick={() => toggleFaceSizePick(id)}
              >
                ×
              </button>
            </div>
          ))}
          <div className={styles.formRow}>
            <input
              className={styles.formInput}
              data-testid="face-size-input"
              type="number"
              step="any"
              value={size}
              disabled={disabled}
              onChange={(e) => setSize(e.target.value)}
              title={text.faceSizeTip}
              aria-label={text.faceSizeTip}
            />
            <span className={styles.toleranceUnit}>mm</span>
          </div>
          <div className={styles.formBtns}>
            <button
              className={styles.cancelBtn}
              onClick={() => setPicking(false)}
            >
              {text.stopPickingFaces}
            </button>
            <button
              className={styles.outlineBtn}
              data-testid="face-size-add"
              disabled={disabled || pickedIds.length === 0 || size === ""}
              onClick={() => addFaceSize(size)}
            >
              {text.setFaceSize}
            </button>
          </div>
        </>
      ) : (
        canPick && (
          <button
            className={styles.outlineBtn}
            data-testid="face-size-pick"
            disabled={disabled}
            onClick={() => setPicking(true)}
          >
            {text.pickFaces}
          </button>
        )
      )}
    </div>
  );
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FaceSelection, LoadKind } from "../../store/modelStore";
import {
  DOF_LABELS,
  FORCE_LABELS,
  MOMENT_LABELS,
  faceKey,
} from "./bcFormUtils";
import styles from "./LeftPanel.module.css";

export function PickedFaceList({
  faces,
  onRemove,
}: {
  faces: FaceSelection[];
  onRemove(index: number): void;
}) {
  if (faces.length === 0) {
    return (
      <div className={styles.pickHint}>Click a face in the 3D viewport</div>
    );
  }
  return (
    <div>
      {faces.map((face, i) => (
        <div key={faceKey(face)} className={styles.bcFaceRow}>
          <span className={styles.bcFaceName}>{face.label}</span>
          <button
            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
            title="Remove face"
            onClick={() => onRemove(i)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function PressureInput({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  return (
    <div className={styles.formRow}>
      <span className={styles.formLabel}>Pressure (MPa)</span>
      <input
        className={styles.formInput}
        type="number"
        value={value}
        step="1"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function LoadVectorInputs({
  kind,
  vec,
  onChange,
}: {
  kind: LoadKind;
  vec: [string, string, string];
  onChange(index: number, value: string): void;
}) {
  const labels = kind === "moment" ? MOMENT_LABELS : FORCE_LABELS;
  const unit = kind === "moment" ? "N·mm" : "N";
  return (
    <>
      {labels.map((label, i) => (
        <div className={styles.formRow} key={label}>
          <span className={styles.formLabel}>
            {label} ({unit})
          </span>
          <input
            className={styles.formInput}
            type="number"
            value={vec[i]}
            step="100"
            onChange={(e) => onChange(i, e.target.value)}
          />
        </div>
      ))}
    </>
  );
}

export function LoadKindSelect({
  value,
  onChange,
}: {
  value: LoadKind;
  onChange(kind: LoadKind): void;
}) {
  return (
    <div className={styles.formRow}>
      <span className={styles.formLabel}>Type</span>
      <select
        className={styles.formSelect}
        value={value}
        onChange={(e) => onChange(e.target.value as LoadKind)}
      >
        <option value="force">Force</option>
        <option value="moment">Moment</option>
        <option value="pressure">Pressure</option>
      </select>
    </div>
  );
}

// Checkbox row for the constrainable DOFs. Solid (H1 displacement) elements
// have only translational DOFs — Ux, Uy, Uz; rotational constraints carry no
// stiffness there and are not offered. Shell (CTRIA3) nodes carry six DOFs,
// so shell models also expose Rx, Ry, Rz (a translations-only fix is a hinged
// support; adding the rotations makes it clamped).
export function DofCheckboxes({
  checkedDofs,
  onToggle,
  showRotations = false,
}: {
  checkedDofs: boolean[];
  onToggle(index: number): void;
  showRotations?: boolean;
}) {
  return (
    <div className={styles.dofGrid}>
      {DOF_LABELS.slice(0, showRotations ? 6 : 3).map((dofLabel, i) => (
        <label key={dofLabel} className={styles.dofCheck}>
          <input
            type="checkbox"
            checked={checkedDofs[i]}
            onChange={() => onToggle(i)}
          />
          {dofLabel}
        </label>
      ))}
    </div>
  );
}

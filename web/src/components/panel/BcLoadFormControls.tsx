// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  FaceSelection,
  LoadKind,
  TieExtent,
} from "../../store/modelStore";
import {
  DOF_LABELS,
  FORCE_LABELS,
  MOMENT_LABELS,
  faceKey,
} from "./bcFormUtils";
import styles from "./LeftPanel.module.css";

// Face / Edge picker for shell models: a flat shell sheet is one face-pick
// region, so grabbing its rim (an edge load or supported-edge BC) needs edge
// picking (#386). Offered only when the model has CTRIA3 elements.
export function PickGeometryToggle({
  value,
  onChange,
}: {
  value: "face" | "edge";
  onChange(geometry: "face" | "edge"): void;
}) {
  return (
    <div className={styles.segToggle} role="group" aria-label="Pick geometry">
      {(["face", "edge"] as const).map((geometry) => (
        <button
          key={geometry}
          type="button"
          className={`${styles.segBtn} ${value === geometry ? styles.segBtnActive : ""}`}
          aria-pressed={value === geometry}
          onClick={() => onChange(geometry)}
        >
          {geometry === "face" ? "Face" : "Edge"}
        </button>
      ))}
    </div>
  );
}

export function PickedFaceList({
  faces,
  onRemove,
  geometry = "face",
}: {
  faces: FaceSelection[];
  onRemove(index: number): void;
  geometry?: "face" | "edge";
}) {
  if (faces.length === 0) {
    return (
      <div className={styles.pickHint}>
        {geometry === "edge"
          ? "Click near a mesh edge in the 3D viewport"
          : "Click a face in the 3D viewport"}
      </div>
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

// Extent of a tie connection: couple the two picked surfaces whole, or only
// where they come within a search distance of each other. The distance input
// appears only for the region extent — for a full coupling there is nothing to
// tune, and a stale number left visible reads as if it still applied.
export function TieExtentInputs({
  extent,
  distance,
  onExtentChange,
  onDistanceChange,
}: {
  extent: TieExtent;
  distance: string;
  onExtentChange(extent: TieExtent): void;
  onDistanceChange(distance: string): void;
}) {
  return (
    <>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Extent</span>
        <select
          className={styles.formSelect}
          data-testid="tie-extent"
          value={extent}
          onChange={(e) => onExtentChange(e.target.value as TieExtent)}
        >
          <option value="full">Full surface</option>
          <option value="region">Within distance</option>
        </select>
      </div>
      {extent === "region" && (
        <div className={styles.formRow}>
          <span className={styles.formLabel}>Search distance</span>
          <input
            className={styles.formInput}
            data-testid="tie-distance"
            type="number"
            min={0}
            step={0.1}
            value={distance}
            onChange={(e) => onDistanceChange(e.target.value)}
          />
          <span className={styles.toleranceUnit}>mm</span>
        </div>
      )}
    </>
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

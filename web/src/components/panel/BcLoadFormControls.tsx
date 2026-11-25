// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  CouplingKind,
  FaceSelection,
  LoadKind,
  PickGeometry,
  ReferencePointOption,
  TieExtent,
  TieMethod,
} from "../../store/modelStore";
import {
  DOF_LABELS,
  FORCE_LABELS,
  MOMENT_LABELS,
  faceKey,
} from "./bcFormUtils";
import { useT } from "../../i18n/useLocale";
import { boundaryMessages } from "../../i18n/messages/boundary";
import styles from "./Panel.module.css";

// What a click selects. `options` is explicit because not every geometry suits
// every model or every condition: edge picking only means something on a shell
// (a closed solid boundary has no boundary polyline to walk), and a point pick
// is not offered where a single node would be the wrong thing to define.
// Rendered only when there is a genuine choice to make.
export function PickGeometryToggle({
  value,
  options,
  onChange,
}: {
  value: PickGeometry;
  options: PickGeometry[];
  onChange(geometry: PickGeometry): void;
}) {
  const text = useT(boundaryMessages);
  if (options.length < 2) return null;
  const label: Record<PickGeometry, string> = {
    face: text.geometryFace,
    edge: text.geometryEdge,
    point: text.geometryPoint,
  };
  return (
    <div
      className={styles.segToggle}
      role="group"
      aria-label={text.pickGeometry}
    >
      {options.map((geometry) => (
        <button
          key={geometry}
          type="button"
          data-testid={`pick-geometry-${geometry}`}
          className={`${styles.segBtn} ${value === geometry ? styles.segBtnActive : ""}`}
          aria-pressed={value === geometry}
          onClick={() => onChange(geometry)}
        >
          {label[geometry]}
        </button>
      ))}
    </div>
  );
}

export function PickedFaceList({
  faces,
  onRemove,
  geometry,
}: {
  faces: FaceSelection[];
  onRemove(index: number): void;
  geometry: PickGeometry;
}) {
  const text = useT(boundaryMessages);
  if (faces.length === 0) {
    const hint: Record<PickGeometry, string> = {
      face: text.pickHintFace,
      edge: text.pickHintEdge,
      point: text.pickHintPoint,
    };
    return <div className={styles.pickHint}>{hint[geometry]}</div>;
  }
  return (
    <div>
      {faces.map((face, i) => (
        <div key={faceKey(face)} className={styles.bcFaceRow}>
          <span className={styles.bcFaceName}>{face.label}</span>
          <button
            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
            title={text.removeFace}
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
  const text = useT(boundaryMessages);
  return (
    <div className={styles.formRow}>
      <span className={styles.formLabel}>{text.pressureMpa}</span>
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
  const text = useT(boundaryMessages);
  return (
    <div className={styles.formRow}>
      <span className={styles.formLabel}>{text.type}</span>
      <select
        className={styles.formSelect}
        value={value}
        onChange={(e) => onChange(e.target.value as LoadKind)}
      >
        <option value="force">{text.force}</option>
        <option value="moment">{text.moment}</option>
        <option value="pressure">{text.pressure}</option>
      </select>
    </div>
  );
}

// Method and extent of a tie connection: join the surfaces by constraint or by
// node-merge, and couple them whole or only where they come within a search
// distance of each other. The distance input appears only for the region
// extent — for a full coupling there is nothing to tune, and a stale number
// left visible reads as if it still applied.
export function TieExtentInputs({
  method,
  extent,
  distance,
  onMethodChange,
  onExtentChange,
  onDistanceChange,
}: {
  method: TieMethod;
  extent: TieExtent;
  distance: string;
  onMethodChange(method: TieMethod): void;
  onExtentChange(extent: TieExtent): void;
  onDistanceChange(distance: string): void;
}) {
  const text = useT(boundaryMessages);
  // What each tie method does to the model, in one line under the select.
  const methodHint: Record<TieMethod, string> = {
    mpc: text.methodMpcHint,
    merge: text.methodMergeHint,
  };
  return (
    <>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{text.method}</span>
        <select
          className={styles.formSelect}
          data-testid="tie-method"
          value={method}
          onChange={(e) => onMethodChange(e.target.value as TieMethod)}
        >
          <option value="mpc">{text.methodMpc}</option>
          <option value="merge">{text.methodMerge}</option>
        </select>
      </div>
      <div className={styles.pickNote}>{methodHint[method]}</div>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{text.extent}</span>
        <select
          className={styles.formSelect}
          data-testid="tie-extent"
          value={extent}
          onChange={(e) => onExtentChange(e.target.value as TieExtent)}
        >
          <option value="full">{text.extentFull}</option>
          <option value="region">{text.extentRegion}</option>
        </select>
      </div>
      {extent === "region" && (
        <div className={styles.formRow}>
          <span className={styles.formLabel}>{text.searchDistance}</span>
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
  showRotations,
}: {
  checkedDofs: boolean[];
  onToggle(index: number): void;
  showRotations: boolean;
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

// How a surface-to-point coupling ties its surface to its reference point. The
// two kinds are not interchangeable — see lib/coupling.ts — so the difference
// is spelled out under the select rather than left to the two words.
export function CouplingKindSelect({
  value,
  onChange,
}: {
  value: CouplingKind;
  onChange(kind: CouplingKind): void;
}) {
  const text = useT(boundaryMessages);
  return (
    <>
      <div className={styles.formRow}>
        <span className={styles.formLabel}>{text.kind}</span>
        <select
          className={styles.formSelect}
          data-testid="coupling-kind"
          value={value}
          onChange={(e) => onChange(e.target.value as CouplingKind)}
        >
          <option value="distributing">{text.distributing}</option>
          <option value="kinematic">{text.kinematic}</option>
        </select>
      </div>
      <div className={styles.pickNote}>
        {value === "distributing" ? text.distributingHint : text.kinematicHint}
      </div>
    </>
  );
}

// Where the reference point sits: one of the positions derived from the picked
// surface (its centre, and the two ends of its axis when it is a cylinder), or
// coordinates typed in. Choosing a derived position fills the coordinate boxes,
// which stay editable — the derived positions are a starting point, not a
// constraint (KOF-208).
export function ReferencePointInputs({
  options,
  coords,
  onCoordChange,
  onPickOption,
}: {
  options: ReferencePointOption[];
  coords: [string, string, string];
  onCoordChange(index: number, value: string): void;
  onPickOption(option: ReferencePointOption): void;
}) {
  const text = useT(boundaryMessages);
  return (
    <>
      {options.length > 0 && (
        <div className={styles.formRow}>
          <span className={styles.formLabel}>{text.placeAt}</span>
          <select
            className={styles.formSelect}
            data-testid="coupling-place-at"
            value=""
            onChange={(e) => {
              const option = options[Number(e.target.value)];
              if (option) onPickOption(option);
            }}
          >
            <option value="">{text.customCoordinates}</option>
            {options.map((option, i) => (
              <option key={option.label} value={i}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {["X", "Y", "Z"].map((axis, i) => (
        <div className={styles.formRow} key={axis}>
          <span className={styles.formLabel}>{axis} (mm)</span>
          <input
            className={styles.formInput}
            data-testid={`coupling-point-${axis.toLowerCase()}`}
            type="number"
            step="0.1"
            value={coords[i]}
            onChange={(e) => onCoordChange(i, e.target.value)}
          />
        </div>
      ))}
    </>
  );
}

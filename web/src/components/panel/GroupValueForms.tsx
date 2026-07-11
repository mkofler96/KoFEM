// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import {
  loadKind,
  loadComponents,
  useModelStore,
} from "../../store/modelStore";
import type {
  LoadKind,
  NamedBcGroup,
  NamedLoadGroup,
} from "../../store/modelStore";
import { DOF_LABELS, parsePressure, parseLoadVector } from "./bcFormUtils";
import {
  DofCheckboxes,
  LoadKindSelect,
  LoadVectorInputs,
  PressureInput,
} from "./BcLoadFormControls";
import styles from "./LeftPanel.module.css";

// Inline editor for a BC group's constrained DOFs and prescribed value —
// opened by the group's ✎ button (issue #258: the values, not just the faces,
// must be editable after creation).
export function BcValueForm({
  group,
  onSave,
  onCancel,
}: {
  group: NamedBcGroup;
  onSave(dofs: number[], value: number): void;
  onCancel(): void;
}) {
  const [checkedDofs, setCheckedDofs] = useState<boolean[]>(
    DOF_LABELS.map((_, i) => group.dofs.includes(i)),
  );
  const [value, setValue] = useState(String(group.value));
  const [error, setError] = useState<string | null>(null);
  // Shell nodes carry rotational DOFs, so shell models expose Rx/Ry/Rz too.
  const hasShells = useModelStore((s) =>
    s.elements.some((el) => el.type === "CTRIA3"),
  );

  function handleSave() {
    // A prescribed displacement of 0 is physically valid (fixed support), so
    // only reject non-finite input — never silently coerce "abc" to 0.
    const parsedValue = parseFloat(value);
    if (!isFinite(parsedValue)) {
      setError("Prescribed displacement must be a finite number");
      return;
    }
    const dofs = checkedDofs
      .map((checked, i) => (checked ? i : -1))
      .filter((i) => i >= 0);
    if (dofs.length === 0) {
      setError("Constrain at least one DOF");
      return;
    }
    onSave(dofs, parsedValue);
  }

  return (
    <div className={styles.inlineForm} data-testid="bc-edit-form">
      {error && (
        <div className={styles.errorBanner} data-testid="bc-edit-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
      <DofCheckboxes
        checkedDofs={checkedDofs}
        showRotations={hasShells}
        onToggle={(index) =>
          setCheckedDofs((prev) =>
            prev.map((checked, i) => (i === index ? !checked : checked)),
          )
        }
      />
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Value</span>
        <input
          className={styles.formInput}
          type="number"
          value={value}
          step="0.001"
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
      <div className={styles.formBtns}>
        <button className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
        <button className={styles.primaryBtn} onClick={handleSave}>
          Save
        </button>
      </div>
    </div>
  );
}

// Inline editor for a load group's kind and values — componentwise force /
// moment vector or pressure magnitude — opened by the group's ✎ button
// (issue #258).
export function LoadValueForm({
  group,
  onSave,
  onCancel,
}: {
  group: NamedLoadGroup;
  onSave(
    kind: LoadKind,
    totalForce: number,
    components?: [number, number, number],
  ): void;
  onCancel(): void;
}) {
  const initialKind = loadKind(group);
  const initialVec = loadComponents(group);
  const [kindSel, setKindSel] = useState<LoadKind>(initialKind);
  const [vec, setVec] = useState<[string, string, string]>([
    String(initialVec[0]),
    String(initialVec[1]),
    String(initialVec[2]),
  ]);
  const [pressureVal, setPressureVal] = useState(
    initialKind === "pressure" ? String(group.totalForce) : "10",
  );
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    if (kindSel === "pressure") {
      const pressure = parsePressure(pressureVal, setError);
      if (pressure === null) return;
      onSave("pressure", pressure);
      return;
    }
    const components = parseLoadVector(vec, kindSel, setError);
    if (components === null) return;
    onSave(kindSel, 0, components);
  }

  return (
    <div className={styles.inlineForm} data-testid="load-edit-form">
      {error && (
        <div className={styles.errorBanner} data-testid="load-edit-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
      <LoadKindSelect value={kindSel} onChange={setKindSel} />
      {kindSel === "pressure" ? (
        <PressureInput value={pressureVal} onChange={setPressureVal} />
      ) : (
        <LoadVectorInputs
          kind={kindSel}
          vec={vec}
          onChange={(index, value) =>
            setVec((prev) => {
              const next = [...prev] as [string, string, string];
              next[index] = value;
              return next;
            })
          }
        />
      )}
      <div className={styles.formBtns}>
        <button className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
        <button className={styles.primaryBtn} onClick={handleSave}>
          Save
        </button>
      </div>
    </div>
  );
}

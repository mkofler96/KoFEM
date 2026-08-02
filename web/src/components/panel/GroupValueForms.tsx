// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from "react";
import {
  loadKind,
  loadComponents,
  referencePointOptions,
  useModelStore,
} from "../../store/modelStore";
import type {
  CouplingGroup,
  CouplingKind,
  LoadKind,
  NamedBcGroup,
  NamedLoadGroup,
  TieExtent,
  TieGroup,
} from "../../store/modelStore";
import {
  DOF_LABELS,
  parsePressure,
  parseLoadVector,
  parseTieDistance,
} from "./bcFormUtils";
import {
  CouplingKindSelect,
  DofCheckboxes,
  LoadKindSelect,
  LoadVectorInputs,
  PressureInput,
  ReferencePointInputs,
  TieExtentInputs,
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

// Inline editor for a tie connection's extent and search distance — opened by
// the connection's ✎ button. The picked surfaces are edited through the face
// rows, exactly as for a BC or a load.
export function TieValueForm({
  group,
  onSave,
  onCancel,
}: {
  group: TieGroup;
  onSave(extent: TieExtent, searchDistance: number): void;
  onCancel(): void;
}) {
  const [extent, setExtent] = useState<TieExtent>(group.extent);
  const [distance, setDistance] = useState(String(group.searchDistance));
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    if (extent === "full") {
      onSave("full", 0);
      return;
    }
    const searchDistance = parseTieDistance(distance, setError);
    if (searchDistance === null) return;
    onSave("region", searchDistance);
  }

  return (
    <div className={styles.inlineForm} data-testid="tie-edit-form">
      {error && (
        <div className={styles.errorBanner} data-testid="tie-edit-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
      <TieExtentInputs
        extent={extent}
        distance={distance}
        onExtentChange={setExtent}
        onDistanceChange={setDistance}
      />
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

// Inline editor for a coupling's kind, tied DOFs and reference point position —
// opened by the coupling's ✎ button. The gripped surface is edited through the
// face rows, exactly as for a BC or a load.
export function CouplingValueForm({
  group,
  onSave,
  onCancel,
}: {
  group: CouplingGroup;
  onSave(
    kind: CouplingKind,
    dofs: number[],
    point: [number, number, number],
  ): void;
  onCancel(): void;
}) {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const setCouplingDraft = useModelStore((s) => s.setCouplingDraft);
  const [kind, setKind] = useState<CouplingKind>(group.kind);
  const [checkedDofs, setCheckedDofs] = useState<boolean[]>(
    DOF_LABELS.map((_, i) => group.dofs.includes(i)),
  );
  const [coords, setCoords] = useState<[string, string, string]>([
    String(group.point[0]),
    String(group.point[1]),
    String(group.point[2]),
  ]);
  const [error, setError] = useState<string | null>(null);

  // Re-derived from the coupling's own surface, so a point can be re-centred
  // after the surface was extended or trimmed.
  const options = useMemo(
    () => referencePointOptions(group.faces, nodes, elements),
    [group.faces, nodes, elements],
  );

  // Preview the edited position in the viewport, alongside the coupling's
  // committed spider — so the point being moved is visible next to where it
  // currently is, which is the comparison the edit is about.
  const draftKey = coords.join(",");
  useEffect(() => {
    const parsed = coords.map((coord) => parseFloat(coord));
    if (parsed.some((coord) => !isFinite(coord))) {
      setCouplingDraft(null);
      return;
    }
    setCouplingDraft({
      point: [parsed[0], parsed[1], parsed[2]],
      nodeIds: group.faces.flatMap((face) => face.nodeIds),
    });
    // Keyed on draftKey rather than `coords`, which is a fresh array on every
    // render: re-running on it would set a new draft object each time, which
    // re-renders, which re-runs.
  }, [draftKey, group.faces, setCouplingDraft]);

  // The preview belongs to this form; closing it must take the preview too.
  useEffect(() => () => setCouplingDraft(null), [setCouplingDraft]);

  function handleSave() {
    const parsed = coords.map((c) => parseFloat(c));
    if (parsed.some((c) => !isFinite(c))) {
      setError("Each reference point coordinate must be a finite number");
      return;
    }
    const dofs = checkedDofs
      .map((checked, i) => (checked ? i : -1))
      .filter((i) => i >= 0);
    if (kind === "kinematic" && dofs.length === 0) {
      setError("A kinematic coupling must tie at least one DOF");
      return;
    }
    onSave(kind, dofs, [parsed[0], parsed[1], parsed[2]]);
  }

  return (
    <div className={styles.inlineForm} data-testid="coupling-edit-form">
      {error && (
        <div className={styles.errorBanner} data-testid="coupling-edit-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
      <CouplingKindSelect value={kind} onChange={setKind} />
      {kind === "kinematic" && (
        <DofCheckboxes
          checkedDofs={checkedDofs}
          showRotations
          onToggle={(index) =>
            setCheckedDofs((prev) =>
              prev.map((checked, i) => (i === index ? !checked : checked)),
            )
          }
        />
      )}
      <ReferencePointInputs
        options={options}
        coords={coords}
        onCoordChange={(index, value) =>
          setCoords((prev) => {
            const next = [...prev] as [string, string, string];
            next[index] = value;
            return next;
          })
        }
        onPickOption={(option) =>
          setCoords([
            String(option.point[0]),
            String(option.point[1]),
            String(option.point[2]),
          ])
        }
      />
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

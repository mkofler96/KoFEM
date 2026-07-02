// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import {
  useModelStore,
  loadKind,
  loadComponents,
} from "../../store/modelStore";
import type {
  FaceSelection,
  LoadKind,
  NamedBcGroup,
  NamedLoadGroup,
} from "../../store/modelStore";
import { fmt } from "../../lib/modelDisplay";
import styles from "./LeftPanel.module.css";

const DOF_LABELS = ["Ux", "Uy", "Uz", "Rx", "Ry", "Rz"];
const FORCE_LABELS = ["Fx", "Fy", "Fz"];
const MOMENT_LABELS = ["Mx", "My", "Mz"];

// One-line summary of a load group for the group list: pressure magnitude, or
// the non-zero force/moment components (e.g. "Fx = 100, Fz = -50 N").
function loadGroupMeta(group: NamedLoadGroup): string {
  const kind = loadKind(group);
  if (kind === "pressure") return `p = ${fmt(group.totalForce)} MPa`;
  const labels = kind === "moment" ? MOMENT_LABELS : FORCE_LABELS;
  const unit = kind === "moment" ? "N·mm" : "N";
  const parts = loadComponents(group)
    .map((value, i) => (value !== 0 ? `${labels[i]} = ${fmt(value)}` : null))
    .filter((part): part is string => part !== null);
  return `${parts.join(", ")} ${unit}`;
}

// Stable list key for a picked face: a face is uniquely determined by its node
// set, so a compact signature of it identifies the entry across re-renders.
function faceKey(face: FaceSelection): string {
  return `${face.nodeIds.length}-${face.nodeIds[0]}-${face.nodeIds[face.nodeIds.length - 1]}`;
}

function toFaceEntries(faces: FaceSelection[], existingCount: number) {
  return faces.map((face, i) => ({
    label: `Face ${existingCount + i + 1}`,
    nodeIds: face.nodeIds,
  }));
}

// A zero pressure is a no-op load: it contributes nothing to the RHS and the
// solver returns a plausible-looking field with the input silently discarded.
// Reject it (and non-finite input) instead of coercing to 0.
function parsePressure(
  raw: string,
  onError: (msg: string) => void,
): number | null {
  const pressure = parseFloat(raw);
  if (!isFinite(pressure) || pressure === 0) {
    onError("Pressure must be a non-zero finite number");
    return null;
  }
  return pressure;
}

// Parse a componentwise force/moment vector. Reject non-finite components and
// the all-zero vector (a no-op load that would be silently discarded).
function parseLoadVector(
  vec: [string, string, string],
  kind: LoadKind,
  onError: (msg: string) => void,
): [number, number, number] | null {
  const noun = kind === "moment" ? "moment" : "force";
  const parsed = vec.map((comp) => parseFloat(comp));
  if (parsed.some((comp) => !isFinite(comp))) {
    onError(`Each ${noun} component must be a finite number`);
    return null;
  }
  if (parsed.every((comp) => comp === 0)) {
    onError(`Specify a non-zero ${noun} component`);
    return null;
  }
  return [parsed[0], parsed[1], parsed[2]];
}

// Shared face-picking session state: the viewport writes clicked faces into
// the store (selectedFace + shift-click pendingFaces); both pick panels read
// and clear it through this hook.
function usePickedFaces(onError: (msg: string | null) => void) {
  const pickTargetGroupId = useModelStore((s) => s.pickTargetGroupId);
  const setPickMode = useModelStore((s) => s.setPickMode);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const setSelectedFace = useModelStore((s) => s.setSelectedFace);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const setPendingFaces = useModelStore((s) => s.setPendingFaces);

  const allPickedFaces = selectedFace
    ? [...pendingFaces, selectedFace]
    : pendingFaces;

  function removePickedFace(index: number) {
    if (index < pendingFaces.length) {
      setPendingFaces(pendingFaces.filter((_, i) => i !== index));
    } else {
      setSelectedFace(null);
    }
  }

  // Leave the pick session — used both on cancel and after a successful apply.
  function endPick() {
    onError(null);
    setPickMode(null);
    setSelectedFace(null);
    setPendingFaces([]);
  }

  function startPickForGroup(kind: "bc" | "load", groupId: number) {
    setPickMode(kind, groupId);
    setSelectedFace(null);
    setPendingFaces([]);
  }

  return {
    pickTargetGroupId,
    setPickMode,
    allPickedFaces,
    removePickedFace,
    endPick,
    startPickForGroup,
  };
}

function PickedFaceList({
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

function PressureInput({
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

function LoadVectorInputs({
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

function LoadKindSelect({
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
// have only translational DOFs — Ux, Uy, Uz. Rotational constraints carry no
// stiffness and are not offered.
function DofCheckboxes({
  checkedDofs,
  onToggle,
}: {
  checkedDofs: boolean[];
  onToggle(index: number): void;
}) {
  return (
    <div className={styles.dofGrid}>
      {DOF_LABELS.slice(0, 3).map((dofLabel, i) => (
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

// Inline editor for a BC group's constrained DOFs and prescribed value —
// opened by the group's ✎ button (issue #258: the values, not just the faces,
// must be editable after creation).
function BcValueForm({
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
function LoadValueForm({
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

// ── Fixed-displacement section ────────────────────────────────────────────────

function BcSection({ onError }: { onError(msg: string | null): void }) {
  const bcGroups = useModelStore((s) => s.bcGroups);
  const pickMode = useModelStore((s) => s.pickMode);
  const createBcGroup = useModelStore((s) => s.createBcGroup);
  const addFaceToBcGroup = useModelStore((s) => s.addFaceToBcGroup);
  const removeFaceFromBcGroup = useModelStore((s) => s.removeFaceFromBcGroup);
  const deleteBcGroup = useModelStore((s) => s.deleteBcGroup);
  const updateBcGroup = useModelStore((s) => s.updateBcGroup);
  const {
    pickTargetGroupId,
    setPickMode,
    allPickedFaces,
    removePickedFace,
    endPick,
    startPickForGroup,
  } = usePickedFaces(onError);

  // Group whose values are being edited inline (✎), if any.
  const [editingBcId, setEditingBcId] = useState<number | null>(null);
  const [checkedDofs, setCheckedDofs] = useState([
    true,
    true,
    true,
    false,
    false,
    false,
  ]);
  const [bcValue, setBcValue] = useState("0");

  const targetBcGroup =
    pickTargetGroupId !== null
      ? (bcGroups.find((group) => group.id === pickTargetGroupId) ?? null)
      : null;

  function applyBc() {
    if (allPickedFaces.length === 0) return;
    const faceEntries = toFaceEntries(
      allPickedFaces,
      targetBcGroup?.faces.length ?? 0,
    );
    if (targetBcGroup) {
      for (const faceEntry of faceEntries) {
        addFaceToBcGroup(targetBcGroup.id, faceEntry);
      }
    } else {
      // A prescribed displacement of 0 is physically valid (fixed support), so
      // only reject non-finite input — never silently coerce "abc" to 0.
      const value = parseFloat(bcValue);
      if (!isFinite(value)) {
        onError("Prescribed displacement must be a finite number");
        return;
      }
      const dofs = checkedDofs
        .map((checked, i) => (checked ? i : -1))
        .filter((i) => i >= 0);
      createBcGroup(faceEntries, dofs, value);
    }
    endPick();
  }

  return (
    <>
      <div className={styles.sectionLabel}>Fixed displacement</div>

      {pickMode !== "bc" && (
        <button
          className={styles.pickBtn}
          onClick={() => setPickMode("bc", null)}
        >
          + Add BC
        </button>
      )}

      {pickMode === "bc" && (
        <div className={styles.pickPanel}>
          <div className={styles.pickPanelHeader}>
            <span className={styles.pickPanelTitle}>
              {targetBcGroup ? `Add face to ${targetBcGroup.name}` : "New BC"}
            </span>
            <button className={styles.iconBtn} onClick={endPick} title="Cancel">
              ✕
            </button>
          </div>

          <PickedFaceList faces={allPickedFaces} onRemove={removePickedFace} />

          {allPickedFaces.length > 0 && !targetBcGroup && (
            <>
              <DofCheckboxes
                checkedDofs={checkedDofs}
                onToggle={(index) =>
                  setCheckedDofs((prev) =>
                    prev.map((checked, i) =>
                      i === index ? !checked : checked,
                    ),
                  )
                }
              />
              <div className={styles.formRow}>
                <span className={styles.formLabel}>Value</span>
                <input
                  className={styles.formInput}
                  type="number"
                  value={bcValue}
                  step="0.001"
                  onChange={(e) => setBcValue(e.target.value)}
                />
              </div>
              <button className={styles.primaryBtn} onClick={applyBc}>
                Apply BC
              </button>
            </>
          )}

          {allPickedFaces.length > 0 && targetBcGroup && (
            <button className={styles.primaryBtn} onClick={applyBc}>
              {allPickedFaces.length === 1
                ? "Add Face"
                : `Add ${allPickedFaces.length} Faces`}
            </button>
          )}
        </div>
      )}

      {/* BC group list */}
      {bcGroups.map((group) => (
        <div key={group.id} className={styles.bcGroup}>
          <div className={styles.bcGroupHeader}>
            <span className={styles.bcDot} />
            <span className={styles.bcGroupName}>{group.name}</span>
            <span className={styles.bcGroupMeta}>
              {group.dofs.map((dof) => DOF_LABELS[dof]).join(", ")} ={" "}
              {group.value}
            </span>
            <div className={styles.treeItemActions}>
              <button
                className={styles.iconBtn}
                title="Add face"
                onClick={() => startPickForGroup("bc", group.id)}
              >
                +
              </button>
              <button
                className={styles.iconBtn}
                title="Edit BC"
                onClick={() =>
                  setEditingBcId(editingBcId === group.id ? null : group.id)
                }
              >
                ✎
              </button>
              <button
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                title="Delete BC"
                onClick={() => deleteBcGroup(group.id)}
              >
                ✕
              </button>
            </div>
          </div>
          {editingBcId === group.id && (
            <BcValueForm
              group={group}
              onSave={(dofs, value) => {
                updateBcGroup(group.id, dofs, value);
                setEditingBcId(null);
              }}
              onCancel={() => setEditingBcId(null)}
            />
          )}
          {group.faces.map((face) => (
            <div key={face.id} className={styles.bcFaceRow}>
              <span className={styles.bcFaceIndent}>└</span>
              <span className={styles.bcFaceName}>{face.label}</span>
              <button
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                title="Remove face"
                onClick={() => removeFaceFromBcGroup(group.id, face.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

// ── Applied-loads section ─────────────────────────────────────────────────────

function LoadSection({ onError }: { onError(msg: string | null): void }) {
  const loadGroups = useModelStore((s) => s.loadGroups);
  const pickMode = useModelStore((s) => s.pickMode);
  const createLoadGroup = useModelStore((s) => s.createLoadGroup);
  const addFaceToLoadGroup = useModelStore((s) => s.addFaceToLoadGroup);
  const removeFaceFromLoadGroup = useModelStore(
    (s) => s.removeFaceFromLoadGroup,
  );
  const deleteLoadGroup = useModelStore((s) => s.deleteLoadGroup);
  const updateLoadGroup = useModelStore((s) => s.updateLoadGroup);
  const {
    pickTargetGroupId,
    setPickMode,
    allPickedFaces,
    removePickedFace,
    endPick,
    startPickForGroup,
  } = usePickedFaces(onError);

  // Group whose values are being edited inline (✎), if any.
  const [editingLoadId, setEditingLoadId] = useState<number | null>(null);
  // A load is defined in two steps (issues #219, #190): pick the kind, then
  // prescribe each component on its own — like the displacement BC above.
  // Force and moment carry a [x,y,z] vector; pressure is a single scalar.
  const [loadKindSel, setLoadKindSel] = useState<LoadKind>("force");
  const [forceVec, setForceVec] = useState<[string, string, string]>([
    "0",
    "-10000",
    "0",
  ]);
  const [momentVec, setMomentVec] = useState<[string, string, string]>([
    "0",
    "0",
    "1000",
  ]);
  const [pressureVal, setPressureVal] = useState("10");

  const targetLoadGroup =
    pickTargetGroupId !== null
      ? (loadGroups.find((group) => group.id === pickTargetGroupId) ?? null)
      : null;

  function applyLoad() {
    if (allPickedFaces.length === 0) return;
    const faceEntries = toFaceEntries(
      allPickedFaces,
      targetLoadGroup?.faces.length ?? 0,
    );
    if (targetLoadGroup) {
      for (const faceEntry of faceEntries) {
        addFaceToLoadGroup(targetLoadGroup.id, faceEntry);
      }
    } else if (loadKindSel === "pressure") {
      const pressure = parsePressure(pressureVal, onError);
      if (pressure === null) return;
      createLoadGroup(faceEntries, 0, pressure, "pressure");
    } else {
      const components = parseLoadVector(
        loadKindSel === "moment" ? momentVec : forceVec,
        loadKindSel,
        onError,
      );
      if (components === null) return;
      createLoadGroup(faceEntries, 0, 0, loadKindSel, components);
    }
    endPick();
  }

  function updateVecComponent(index: number, value: string) {
    const setVec = loadKindSel === "moment" ? setMomentVec : setForceVec;
    setVec((prev) => {
      const next = [...prev] as [string, string, string];
      next[index] = value;
      return next;
    });
  }

  return (
    <>
      <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
        Applied loads
      </div>

      {pickMode !== "load" && (
        <button
          className={styles.pickBtn}
          onClick={() => setPickMode("load", null)}
        >
          + Add Load
        </button>
      )}

      {pickMode === "load" && (
        <div className={styles.pickPanel}>
          <div className={styles.pickPanelHeader}>
            <span className={styles.pickPanelTitle}>
              {targetLoadGroup
                ? `Add face to ${targetLoadGroup.name}`
                : "New Load"}
            </span>
            <button className={styles.iconBtn} onClick={endPick} title="Cancel">
              ✕
            </button>
          </div>

          <PickedFaceList faces={allPickedFaces} onRemove={removePickedFace} />

          {allPickedFaces.length > 0 && !targetLoadGroup && (
            <>
              {/* Step 1 — pick the load kind. */}
              <LoadKindSelect value={loadKindSel} onChange={setLoadKindSel} />
              {/* Step 2 — prescribe each component on its own. */}
              {loadKindSel === "pressure" ? (
                <PressureInput value={pressureVal} onChange={setPressureVal} />
              ) : (
                <LoadVectorInputs
                  kind={loadKindSel}
                  vec={loadKindSel === "moment" ? momentVec : forceVec}
                  onChange={updateVecComponent}
                />
              )}
              <div className={styles.pickNote}>
                {loadKindSel === "pressure"
                  ? "applied as p·n̂ over each face (work-equivalent)"
                  : loadKindSel === "force"
                    ? "applied as a work-equivalent surface traction"
                    : "distributed as equivalent nodal forces"}
              </div>
              <button className={styles.loadBtn} onClick={applyLoad}>
                Apply Load
              </button>
            </>
          )}

          {allPickedFaces.length > 0 && targetLoadGroup && (
            <button className={styles.loadBtn} onClick={applyLoad}>
              {allPickedFaces.length === 1
                ? "Add Face"
                : `Add ${allPickedFaces.length} Faces`}
            </button>
          )}
        </div>
      )}

      {/* Load group list */}
      {loadGroups.map((group) => (
        <div key={group.id} className={styles.bcGroup}>
          <div className={styles.bcGroupHeader}>
            <span className={styles.loadDot} />
            <span className={styles.bcGroupName}>{group.name}</span>
            <span className={styles.bcGroupMeta}>{loadGroupMeta(group)}</span>
            <div className={styles.treeItemActions}>
              <button
                className={styles.iconBtn}
                title="Add face"
                onClick={() => startPickForGroup("load", group.id)}
              >
                +
              </button>
              <button
                className={styles.iconBtn}
                title="Edit load"
                onClick={() =>
                  setEditingLoadId(editingLoadId === group.id ? null : group.id)
                }
              >
                ✎
              </button>
              <button
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                title="Delete Load"
                onClick={() => deleteLoadGroup(group.id)}
              >
                ✕
              </button>
            </div>
          </div>
          {editingLoadId === group.id && (
            <LoadValueForm
              group={group}
              onSave={(kind, totalForce, components) => {
                updateLoadGroup(group.id, kind, totalForce, components);
                setEditingLoadId(null);
              }}
              onCancel={() => setEditingLoadId(null)}
            />
          )}
          {group.faces.map((face) => (
            <div key={face.id} className={styles.bcFaceRow}>
              <span className={styles.bcFaceIndent}>└</span>
              <span className={styles.bcFaceName}>{face.label}</span>
              <button
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                title="Remove face"
                onClick={() => removeFaceFromLoadGroup(group.id, face.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

export function BoundaryConditionsPanel() {
  // Boundary conditions and loads reference mesh nodes, so they can only be
  // defined once a volume mesh exists.
  const meshOk = useModelStore((s) => s.nodes.length > 0);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className={styles.panel}>
      <div className={styles.tabContent}>
        {error && (
          <div className={styles.errorBanner} data-testid="constraints-error">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}
        {!meshOk && (
          <div className={styles.empty} data-testid="no-mesh-hint">
            Generate a mesh before adding boundary conditions.
          </div>
        )}
        {meshOk && (
          <>
            <BcSection onError={setError} />
            <LoadSection onError={setError} />
          </>
        )}
      </div>
    </div>
  );
}

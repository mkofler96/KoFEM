// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import {
  useModelStore,
  loadKind,
  loadComponents,
} from "../../store/modelStore";
import type {
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
function loadGroupMeta(g: NamedLoadGroup): string {
  const kind = loadKind(g);
  if (kind === "pressure") return `p = ${fmt(g.totalForce)} MPa`;
  const labels = kind === "moment" ? ["Mx", "My", "Mz"] : ["Fx", "Fy", "Fz"];
  const unit = kind === "moment" ? "N·mm" : "N";
  const parts = loadComponents(g)
    .map((v, i) => (v !== 0 ? `${labels[i]} = ${fmt(v)}` : null))
    .filter((p): p is string => p !== null);
  return `${parts.join(", ")} ${unit}`;
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
    const dofs = checkedDofs.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
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
      <div className={styles.dofGrid}>
        {/* Solid (H1 displacement) elements have only translational DOFs —
        Ux, Uy, Uz. Rotational constraints carry no stiffness and are not
        offered. */}
        {DOF_LABELS.slice(0, 3).map((d, i) => (
          <label key={d} className={styles.dofCheck}>
            <input
              type="checkbox"
              checked={checkedDofs[i]}
              onChange={() =>
                setCheckedDofs((p) => p.map((v, j) => (j === i ? !v : v)))
              }
            />
            {d}
          </label>
        ))}
      </div>
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
      // A zero pressure is a no-op load: it contributes nothing to the RHS and
      // the solver returns a plausible-looking field with the input silently
      // discarded. Reject it (and non-finite input) instead of coercing to 0.
      const pressure = parseFloat(pressureVal);
      if (!isFinite(pressure) || pressure === 0) {
        setError("Pressure must be a non-zero finite number");
        return;
      }
      onSave("pressure", pressure);
      return;
    }
    // Force / moment, prescribed componentwise. Reject non-finite components
    // and the all-zero vector (a no-op load that would be silently discarded).
    const noun = kindSel === "moment" ? "moment" : "force";
    const parsed = vec.map((comp) => parseFloat(comp));
    if (parsed.some((comp) => !isFinite(comp))) {
      setError(`Each ${noun} component must be a finite number`);
      return;
    }
    if (parsed.every((comp) => comp === 0)) {
      setError(`Specify a non-zero ${noun} component`);
      return;
    }
    onSave(kindSel, 0, [parsed[0], parsed[1], parsed[2]]);
  }

  const labels = kindSel === "moment" ? MOMENT_LABELS : FORCE_LABELS;
  const unit = kindSel === "moment" ? "N·mm" : "N";

  return (
    <div className={styles.inlineForm} data-testid="load-edit-form">
      {error && (
        <div className={styles.errorBanner} data-testid="load-edit-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}
      <div className={styles.formRow}>
        <span className={styles.formLabel}>Type</span>
        <select
          className={styles.formSelect}
          value={kindSel}
          onChange={(e) => setKindSel(e.target.value as LoadKind)}
        >
          <option value="force">Force</option>
          <option value="moment">Moment</option>
          <option value="pressure">Pressure</option>
        </select>
      </div>
      {kindSel === "pressure" ? (
        <div className={styles.formRow}>
          <span className={styles.formLabel}>Pressure (MPa)</span>
          <input
            className={styles.formInput}
            type="number"
            value={pressureVal}
            step="1"
            onChange={(e) => setPressureVal(e.target.value)}
          />
        </div>
      ) : (
        labels.map((label, i) => (
          <div className={styles.formRow} key={label}>
            <span className={styles.formLabel}>
              {label} ({unit})
            </span>
            <input
              className={styles.formInput}
              type="number"
              value={vec[i]}
              step="100"
              onChange={(e) => {
                const value = e.target.value;
                setVec((p) => {
                  const next = [...p] as [string, string, string];
                  next[i] = value;
                  return next;
                });
              }}
            />
          </div>
        ))
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

export function BoundaryConditionsPanel() {
  const nodes = useModelStore((s) => s.nodes);
  const bcGroups = useModelStore((s) => s.bcGroups);
  const loadGroups = useModelStore((s) => s.loadGroups);
  const pickMode = useModelStore((s) => s.pickMode);
  const pickTargetGroupId = useModelStore((s) => s.pickTargetGroupId);
  const setPickMode = useModelStore((s) => s.setPickMode);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const setSelectedFace = useModelStore((s) => s.setSelectedFace);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const setPendingFaces = useModelStore((s) => s.setPendingFaces);
  const createBcGroup = useModelStore((s) => s.createBcGroup);
  const addFaceToBcGroup = useModelStore((s) => s.addFaceToBcGroup);
  const removeFaceFromBcGroup = useModelStore((s) => s.removeFaceFromBcGroup);
  const deleteBcGroup = useModelStore((s) => s.deleteBcGroup);
  const createLoadGroup = useModelStore((s) => s.createLoadGroup);
  const addFaceToLoadGroup = useModelStore((s) => s.addFaceToLoadGroup);
  const removeFaceFromLoadGroup = useModelStore(
    (s) => s.removeFaceFromLoadGroup,
  );
  const deleteLoadGroup = useModelStore((s) => s.deleteLoadGroup);
  const updateBcGroup = useModelStore((s) => s.updateBcGroup);
  const updateLoadGroup = useModelStore((s) => s.updateLoadGroup);

  // Group whose values are being edited inline (✎), if any.
  const [editingBcId, setEditingBcId] = useState<number | null>(null);
  const [editingLoadId, setEditingLoadId] = useState<number | null>(null);

  const [checkedDofs, setCheckedDofs] = useState([
    true,
    true,
    true,
    false,
    false,
    false,
  ]);
  // A load is defined in two steps (issues #219, #190): pick the kind, then
  // prescribe each component on its own — like the displacement BC above. Force
  // and moment carry a [x,y,z] vector; pressure is a single scalar.
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
  const [bcValue, setBcValue] = useState("0");
  const [error, setError] = useState<string | null>(null);

  // Boundary conditions and loads reference mesh nodes, so they can only be
  // defined once a volume mesh exists.
  const meshOk = nodes.length > 0;

  const targetBcGroup =
    pickTargetGroupId !== null
      ? (bcGroups.find((g) => g.id === pickTargetGroupId) ?? null)
      : null;
  const targetLoadGroup =
    pickTargetGroupId !== null
      ? (loadGroups.find((g) => g.id === pickTargetGroupId) ?? null)
      : null;

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

  function cancelPick() {
    setError(null);
    setPickMode(null);
    setSelectedFace(null);
    setPendingFaces([]);
  }

  function applyBc() {
    if (allPickedFaces.length === 0) return;
    const existingCount = targetBcGroup?.faces.length ?? 0;
    const faceEntries = allPickedFaces.map((f, i) => ({
      label: `Face ${existingCount + i + 1}`,
      nodeIds: f.nodeIds,
    }));
    if (targetBcGroup) {
      for (const fe of faceEntries) addFaceToBcGroup(targetBcGroup.id, fe);
    } else {
      // A prescribed displacement of 0 is physically valid (fixed support), so
      // only reject non-finite input — never silently coerce "abc" to 0.
      const value = parseFloat(bcValue);
      if (!isFinite(value)) {
        setError("Prescribed displacement must be a finite number");
        return;
      }
      const dofs = checkedDofs
        .map((c, i) => (c ? i : -1))
        .filter((i) => i >= 0);
      createBcGroup(faceEntries, dofs, value);
    }
    setError(null);
    setPickMode(null);
    setSelectedFace(null);
    setPendingFaces([]);
  }

  function applyLoad() {
    if (allPickedFaces.length === 0) return;
    const existingCount = targetLoadGroup?.faces.length ?? 0;
    const faceEntries = allPickedFaces.map((f, i) => ({
      label: `Face ${existingCount + i + 1}`,
      nodeIds: f.nodeIds,
    }));
    if (targetLoadGroup) {
      for (const fe of faceEntries) addFaceToLoadGroup(targetLoadGroup.id, fe);
    } else if (loadKindSel === "pressure") {
      // A zero pressure is a no-op load: it contributes nothing to the RHS and
      // the solver returns a plausible-looking field with the input silently
      // discarded. Reject it (and non-finite input) instead of coercing to 0.
      const p = parseFloat(pressureVal);
      if (!isFinite(p) || p === 0) {
        setError("Pressure must be a non-zero finite number");
        return;
      }
      createLoadGroup(faceEntries, 0, p, "pressure");
    } else {
      // Force / moment, prescribed componentwise. Reject non-finite components
      // and the all-zero vector (a no-op load that would be silently discarded).
      const noun = loadKindSel === "moment" ? "moment" : "force";
      const parsed = (loadKindSel === "moment" ? momentVec : forceVec).map(
        (comp) => parseFloat(comp),
      );
      if (parsed.some((comp) => !isFinite(comp))) {
        setError(`Each ${noun} component must be a finite number`);
        return;
      }
      if (parsed.every((comp) => comp === 0)) {
        setError(`Specify a non-zero ${noun} component`);
        return;
      }
      createLoadGroup(faceEntries, 0, 0, loadKindSel, [
        parsed[0],
        parsed[1],
        parsed[2],
      ]);
    }
    setError(null);
    setPickMode(null);
    setSelectedFace(null);
    setPendingFaces([]);
  }

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
            {/* ── BC section ────────────────────────────────────── */}
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
                    {targetBcGroup
                      ? `Add face to ${targetBcGroup.name}`
                      : "New BC"}
                  </span>
                  <button
                    className={styles.iconBtn}
                    onClick={cancelPick}
                    title="Cancel"
                  >
                    ✕
                  </button>
                </div>

                {allPickedFaces.length === 0 ? (
                  <div className={styles.pickHint}>
                    Click a face in the 3D viewport
                  </div>
                ) : (
                  <div>
                    {allPickedFaces.map((f, i) => (
                      <div key={i} className={styles.bcFaceRow}>
                        <span className={styles.bcFaceName}>{f.label}</span>
                        <button
                          className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                          title="Remove face"
                          onClick={() => removePickedFace(i)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {allPickedFaces.length > 0 && !targetBcGroup && (
                  <>
                    <div className={styles.dofGrid}>
                      {/* Solid (H1 displacement) elements have only translational
                      DOFs — Ux, Uy, Uz. Rotational constraints carry no
                      stiffness and are not offered. */}
                      {DOF_LABELS.slice(0, 3).map((d, i) => (
                        <label key={d} className={styles.dofCheck}>
                          <input
                            type="checkbox"
                            checked={checkedDofs[i]}
                            onChange={() =>
                              setCheckedDofs((p) =>
                                p.map((v, j) => (j === i ? !v : v)),
                              )
                            }
                          />
                          {d}
                        </label>
                      ))}
                    </div>
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
            {bcGroups.map((g) => (
              <div key={g.id} className={styles.bcGroup}>
                <div className={styles.bcGroupHeader}>
                  <span className={styles.bcDot} />
                  <span className={styles.bcGroupName}>{g.name}</span>
                  <span className={styles.bcGroupMeta}>
                    {g.dofs.map((d) => DOF_LABELS[d]).join(", ")} = {g.value}
                  </span>
                  <div className={styles.treeItemActions}>
                    <button
                      className={styles.iconBtn}
                      title="Add face"
                      onClick={() => {
                        setPickMode("bc", g.id);
                        setSelectedFace(null);
                        setPendingFaces([]);
                      }}
                    >
                      +
                    </button>
                    <button
                      className={styles.iconBtn}
                      title="Edit BC"
                      onClick={() =>
                        setEditingBcId(editingBcId === g.id ? null : g.id)
                      }
                    >
                      ✎
                    </button>
                    <button
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      title="Delete BC"
                      onClick={() => deleteBcGroup(g.id)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {editingBcId === g.id && (
                  <BcValueForm
                    group={g}
                    onSave={(dofs, value) => {
                      updateBcGroup(g.id, dofs, value);
                      setEditingBcId(null);
                    }}
                    onCancel={() => setEditingBcId(null)}
                  />
                )}
                {g.faces.map((f) => (
                  <div key={f.id} className={styles.bcFaceRow}>
                    <span className={styles.bcFaceIndent}>└</span>
                    <span className={styles.bcFaceName}>{f.label}</span>
                    <button
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      title="Remove face"
                      onClick={() => removeFaceFromBcGroup(g.id, f.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ))}

            {/* ── Load section ───────────────────────────────────── */}
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
                  <button
                    className={styles.iconBtn}
                    onClick={cancelPick}
                    title="Cancel"
                  >
                    ✕
                  </button>
                </div>

                {allPickedFaces.length === 0 ? (
                  <div className={styles.pickHint}>
                    Click a face in the 3D viewport
                  </div>
                ) : (
                  <div>
                    {allPickedFaces.map((f, i) => (
                      <div key={i} className={styles.bcFaceRow}>
                        <span className={styles.bcFaceName}>{f.label}</span>
                        <button
                          className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                          title="Remove face"
                          onClick={() => removePickedFace(i)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {allPickedFaces.length > 0 && !targetLoadGroup && (
                  <>
                    {/* Step 1 — pick the load kind. */}
                    <div className={styles.formRow}>
                      <span className={styles.formLabel}>Type</span>
                      <select
                        className={styles.formSelect}
                        value={loadKindSel}
                        onChange={(e) =>
                          setLoadKindSel(e.target.value as LoadKind)
                        }
                      >
                        <option value="force">Force</option>
                        <option value="moment">Moment</option>
                        <option value="pressure">Pressure</option>
                      </select>
                    </div>

                    {/* Step 2 — prescribe each component on its own. */}
                    {loadKindSel === "pressure" ? (
                      <div className={styles.formRow}>
                        <span className={styles.formLabel}>Pressure (MPa)</span>
                        <input
                          className={styles.formInput}
                          type="number"
                          value={pressureVal}
                          step="1"
                          onChange={(e) => setPressureVal(e.target.value)}
                        />
                      </div>
                    ) : (
                      (loadKindSel === "moment"
                        ? MOMENT_LABELS
                        : FORCE_LABELS
                      ).map((label, i) => {
                        const vec =
                          loadKindSel === "moment" ? momentVec : forceVec;
                        const setVec =
                          loadKindSel === "moment" ? setMomentVec : setForceVec;
                        const unit = loadKindSel === "moment" ? "N·mm" : "N";
                        return (
                          <div className={styles.formRow} key={label}>
                            <span className={styles.formLabel}>
                              {label} ({unit})
                            </span>
                            <input
                              className={styles.formInput}
                              type="number"
                              value={vec[i]}
                              step="100"
                              onChange={(e) => {
                                const value = e.target.value;
                                setVec((p) => {
                                  const next = [...p] as [
                                    string,
                                    string,
                                    string,
                                  ];
                                  next[i] = value;
                                  return next;
                                });
                              }}
                            />
                          </div>
                        );
                      })
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
            {loadGroups.map((g) => (
              <div key={g.id} className={styles.bcGroup}>
                <div className={styles.bcGroupHeader}>
                  <span className={styles.loadDot} />
                  <span className={styles.bcGroupName}>{g.name}</span>
                  <span className={styles.bcGroupMeta}>{loadGroupMeta(g)}</span>
                  <div className={styles.treeItemActions}>
                    <button
                      className={styles.iconBtn}
                      title="Add face"
                      onClick={() => {
                        setPickMode("load", g.id);
                        setSelectedFace(null);
                        setPendingFaces([]);
                      }}
                    >
                      +
                    </button>
                    <button
                      className={styles.iconBtn}
                      title="Edit load"
                      onClick={() =>
                        setEditingLoadId(editingLoadId === g.id ? null : g.id)
                      }
                    >
                      ✎
                    </button>
                    <button
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      title="Delete Load"
                      onClick={() => deleteLoadGroup(g.id)}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {editingLoadId === g.id && (
                  <LoadValueForm
                    group={g}
                    onSave={(kind, totalForce, components) => {
                      updateLoadGroup(g.id, kind, totalForce, components);
                      setEditingLoadId(null);
                    }}
                    onCancel={() => setEditingLoadId(null)}
                  />
                )}
                {g.faces.map((f) => (
                  <div key={f.id} className={styles.bcFaceRow}>
                    <span className={styles.bcFaceIndent}>└</span>
                    <span className={styles.bcFaceName}>{f.label}</span>
                    <button
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      title="Remove face"
                      onClick={() => removeFaceFromLoadGroup(g.id, f.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

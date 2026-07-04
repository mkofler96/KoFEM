// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import type { LoadKind } from "../../store/modelStore";
import { usePickedFaces } from "../../hooks/usePickedFaces";
import {
  loadGroupMeta,
  parseLoadVector,
  parsePressure,
  toFaceEntries,
} from "./bcFormUtils";
import {
  LoadKindSelect,
  LoadVectorInputs,
  PickedFaceList,
  PressureInput,
} from "./BcLoadFormControls";
import { LoadValueForm } from "./GroupValueForms";
import { GroupCard } from "./GroupCard";
import styles from "./LeftPanel.module.css";

// Applied-loads section: pick faces, create/extend load groups (componentwise
// force / moment or pressure), and list the existing groups with their inline
// editors.
export function LoadSection({
  onError,
}: {
  onError(msg: string | null): void;
}) {
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

      {loadGroups.map((group) => (
        <GroupCard
          key={group.id}
          name={group.name}
          meta={loadGroupMeta(group)}
          dotClassName={styles.loadDot}
          editTitle="Edit load"
          deleteTitle="Delete Load"
          faces={group.faces}
          editForm={
            editingLoadId === group.id && (
              <LoadValueForm
                group={group}
                onSave={(kind, totalForce, components) => {
                  updateLoadGroup(group.id, kind, totalForce, components);
                  setEditingLoadId(null);
                }}
                onCancel={() => setEditingLoadId(null)}
              />
            )
          }
          onStartPick={() => startPickForGroup("load", group.id)}
          onToggleEdit={() =>
            setEditingLoadId(editingLoadId === group.id ? null : group.id)
          }
          onDelete={() => deleteLoadGroup(group.id)}
          onRemoveFace={(faceId) => removeFaceFromLoadGroup(group.id, faceId)}
        />
      ))}
    </>
  );
}

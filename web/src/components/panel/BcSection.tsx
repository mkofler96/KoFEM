// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import { usePickedFaces } from "../../hooks/usePickedFaces";
import { DOF_LABELS, toFaceEntries } from "./bcFormUtils";
import {
  DofCheckboxes,
  PickedFaceList,
  PickGeometryToggle,
} from "./BcLoadFormControls";
import { BcValueForm } from "./GroupValueForms";
import { GroupCard } from "./GroupCard";
import styles from "./LeftPanel.module.css";

// Fixed-displacement section: pick faces, create/extend BC groups, and list
// the existing groups with their inline editors.
export function BcSection({ onError }: { onError(msg: string | null): void }) {
  const bcGroups = useModelStore((s) => s.bcGroups);
  const pickMode = useModelStore((s) => s.pickMode);
  const pickGeometry = useModelStore((s) => s.pickGeometry);
  const setPickGeometry = useModelStore((s) => s.setPickGeometry);
  // Shell nodes carry rotational DOFs, so shell models expose Rx/Ry/Rz too, and
  // edge picking (grabbing the rim of the flat sheet) is only offered for them.
  const hasShells = useModelStore((s) =>
    s.elements.some((el) => el.type === "CTRIA3"),
  );
  const couplingGroups = useModelStore((s) => s.couplingGroups);
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
  // Whether the pick has landed on a coupling's reference point — clicked in
  // the viewport like anything else. Such a point carries six real DOFs
  // (shell_core gives a coupling reference its rotations), so the rotational
  // boxes become meaningful: fixing them is how a bolted or welded connection
  // is restrained without clamping every node of the bore.
  const refPoints = new Set(couplingGroups.map((c) => c.refNodeId));
  const pickedReferencePoint = allPickedFaces.some((face) =>
    face.nodeIds.every((id) => refPoints.has(id)),
  );

  const targetBcGroup =
    pickTargetGroupId !== null
      ? (bcGroups.find((group) => group.id === pickTargetGroupId) ?? null)
      : null;

  function applyBc() {
    if (allPickedFaces.length === 0) return;
    const faceEntries = toFaceEntries(
      allPickedFaces,
      // eslint-disable-next-line kofem/no-silent-fallback -- numbering offset for the new entries; a pick with no target group starts a fresh group, which has 0 faces
      targetBcGroup?.faces.length ?? 0,
      pickGeometry,
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

          {/* Point picking is offered so a coupling's REFERENCE POINT can be
              fixed — clicked in the viewport like any other selection, which is
              the only way to restrain a bolted hole without clamping every node
              of its bore. It also allows a single mesh node, which is a
              legitimate way to remove a rigid-body mode. */}
          <PickGeometryToggle
            value={pickGeometry}
            options={hasShells ? ["face", "edge", "point"] : ["face", "point"]}
            onChange={setPickGeometry}
          />

          <PickedFaceList
            faces={allPickedFaces}
            onRemove={removePickedFace}
            geometry={pickGeometry}
          />

          {allPickedFaces.length > 0 && !targetBcGroup && (
            <>
              {/* A reference point carries six DOFs whichever elements the
                  model has, so Rx/Ry/Rz appear as soon as one is picked. */}
              <DofCheckboxes
                checkedDofs={checkedDofs}
                showRotations={hasShells || pickedReferencePoint}
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

      {bcGroups.map((group) => (
        <GroupCard
          key={group.id}
          name={group.name}
          meta={`${group.dofs.map((dof) => DOF_LABELS[dof]).join(", ")} = ${group.value}`}
          dotClassName={styles.bcDot}
          editTitle="Edit BC"
          deleteTitle="Delete BC"
          faces={group.faces}
          editForm={
            editingBcId === group.id && (
              <BcValueForm
                group={group}
                onSave={(dofs, value) => {
                  updateBcGroup(group.id, dofs, value);
                  setEditingBcId(null);
                }}
                onCancel={() => setEditingBcId(null)}
              />
            )
          }
          onStartPick={() => startPickForGroup("bc", group.id)}
          onToggleEdit={() =>
            setEditingBcId(editingBcId === group.id ? null : group.id)
          }
          onDelete={() => deleteBcGroup(group.id)}
          onRemoveFace={(faceId) => removeFaceFromBcGroup(group.id, faceId)}
        />
      ))}
    </>
  );
}

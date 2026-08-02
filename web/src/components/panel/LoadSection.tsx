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
  PickGeometryToggle,
  PressureInput,
  ReferencePointSelect,
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
  const pickGeometry = useModelStore((s) => s.pickGeometry);
  const setPickGeometry = useModelStore((s) => s.setPickGeometry);
  // Edge picking (grabbing the rim of the flat sheet for a line load) is only
  // offered for shell models — a flat shell is a single face-pick region.
  const hasShells = useModelStore((s) =>
    s.elements.some((el) => el.type === "CTRIA3"),
  );
  // A nodal MOMENT only reaches the solver on the pure-shell path
  // (shellPointLoads carries DOFs 3..5). The solid and coupled assemblers give
  // an ordinary mesh node three translations only and drop a rotational load,
  // so on those a couple has to go through a coupling's reference point.
  const isPureShell = useModelStore(
    (s) =>
      s.elements.length > 0 && s.elements.every((el) => el.type === "CTRIA3"),
  );
  const couplingGroups = useModelStore((s) => s.couplingGroups);
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
  // A coupling's reference point, when the load acts on one instead of (or as
  // well as) a picked surface. This is what carries a MOMENT into a solid model:
  // the point has rotational DOFs, so the couple is applied directly and the
  // coupling spreads it over the gripped surface (rebuildLoads / coupledLoads).
  const [refNodeId, setRefNodeId] = useState<number | null>(null);
  const refPointEntry = () => {
    const coupling = couplingGroups.find((c) => c.refNodeId === refNodeId);
    return coupling
      ? [
          {
            label: `${coupling.name} reference point`,
            nodeIds: [coupling.refNodeId],
          },
        ]
      : [];
  };

  const targetLoadGroup =
    pickTargetGroupId !== null
      ? (loadGroups.find((group) => group.id === pickTargetGroupId) ?? null)
      : null;

  function applyLoad() {
    if (allPickedFaces.length === 0 && refNodeId === null) return;
    const faceEntries = [
      ...toFaceEntries(
        allPickedFaces,
        // eslint-disable-next-line kofem/no-silent-fallback -- numbering offset for the new entries; a pick with no target group starts a fresh group, which has 0 faces
        targetLoadGroup?.faces.length ?? 0,
        pickGeometry,
      ),
      ...refPointEntry(),
    ];
    if (targetLoadGroup) {
      for (const faceEntry of faceEntries) {
        addFaceToLoadGroup(targetLoadGroup.id, faceEntry);
      }
    } else if (loadKindSel === "pressure") {
      // A pressure is a traction per unit area, and neither a reference point
      // nor a single node has any. Refuse it here rather than create a group
      // whose selection contributes nothing to the solve.
      if (refNodeId !== null) {
        onError(
          "A pressure cannot act on a reference point — it has no area. Apply a force or a moment there, or pick a surface.",
        );
        return;
      }
      if (pickGeometry === "point" && allPickedFaces.length > 0) {
        onError(
          "A pressure cannot act on a single node — it has no area. Apply a force there, or pick a face.",
        );
        return;
      }
      const pressure = parsePressure(pressureVal, onError);
      if (pressure === null) return;
      createLoadGroup(faceEntries, 0, pressure, "pressure");
    } else {
      if (
        loadKindSel === "moment" &&
        pickGeometry === "point" &&
        allPickedFaces.length > 0 &&
        !isPureShell
      ) {
        onError(
          "A moment cannot act on a single node of a solid mesh — its nodes carry no " +
            "rotational DOF, so the couple would be dropped. Couple the surface to a " +
            "reference point and apply the moment there.",
        );
        return;
      }
      const components = parseLoadVector(
        loadKindSel === "moment" ? momentVec : forceVec,
        loadKindSel,
        onError,
      );
      if (components === null) return;
      createLoadGroup(faceEntries, 0, 0, loadKindSel, components);
    }
    setRefNodeId(null);
    endPick();
  }

  // How the load about to be created will actually reach the solver. The three
  // routes are genuinely different physics — an integrated traction, a
  // concentrated nodal load, and a couple carried by a coupling — so which one
  // a selection lands on is worth saying before it is applied.
  function applicationNote(): string {
    if (loadKindSel === "pressure")
      return "applied as p·n̂ over each face (work-equivalent)";
    if (loadKindSel === "force") {
      if (refNodeId !== null && allPickedFaces.length === 0)
        return "applied at the reference point, and spread over its coupled surface";
      if (pickGeometry === "point")
        return "applied at the picked node as a concentrated force";
      if (pickGeometry === "edge")
        return "applied as a work-equivalent line load along the edge";
      return "applied as a work-equivalent surface traction";
    }
    if (refNodeId !== null)
      return "applied to the reference point as a couple, and spread over its coupled surface";
    if (pickGeometry === "point")
      return isPureShell
        ? "applied at the picked node as a couple"
        : "a solid mesh node carries no rotation — use a coupling's reference point";
    return "distributed as equivalent nodal forces";
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

          {/* A point load is applied at the node itself rather than integrated
              over a surface, which is the only way to state a concentrated
              force — a lug pin, a bolt reaction — on a mesh that has no element
              face to spread it over. */}
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

          <ReferencePointSelect
            couplings={couplingGroups}
            value={refNodeId}
            onChange={setRefNodeId}
          />

          {(allPickedFaces.length > 0 || refNodeId !== null) &&
            !targetLoadGroup && (
              <>
                {/* Step 1 — pick the load kind. */}
                <LoadKindSelect value={loadKindSel} onChange={setLoadKindSel} />
                {/* Step 2 — prescribe each component on its own. */}
                {loadKindSel === "pressure" ? (
                  <PressureInput
                    value={pressureVal}
                    onChange={setPressureVal}
                  />
                ) : (
                  <LoadVectorInputs
                    kind={loadKindSel}
                    vec={loadKindSel === "moment" ? momentVec : forceVec}
                    onChange={updateVecComponent}
                  />
                )}
                <div className={styles.pickNote}>{applicationNote()}</div>
                <button className={styles.loadBtn} onClick={applyLoad}>
                  Apply Load
                </button>
              </>
            )}

          {(allPickedFaces.length > 0 || refNodeId !== null) &&
            targetLoadGroup && (
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

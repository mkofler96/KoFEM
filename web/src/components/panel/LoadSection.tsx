// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { useModelStore } from "../../store/modelStore";
import type { LoadKind } from "../../store/modelStore";
import { usePickedFaces } from "../../hooks/usePickedFaces";
import { useFemModule } from "../../hooks/useFemModule";
import { loadFigures, loadSummaryText } from "../../lib/groupSummary";
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
} from "./BcLoadFormControls";
import { LoadValueForm } from "./GroupValueForms";
import { GroupCard } from "./GroupCard";
import {
  focusedId,
  showsItem,
  showsPick,
  useStartOnAdd,
  type SectionFocus,
} from "./sectionFocus";
import { useIntlTag, useT } from "../../i18n/useLocale";
import { boundaryMessages } from "../../i18n/messages/boundary";
import styles from "./Panel.module.css";

// Applied-loads section: pick faces to create a load group (componentwise
// force / moment or pressure), or edit / extend one group — see SectionFocus.
export function LoadSection({
  onError,
  focus,
}: {
  onError(msg: string | null): void;
  focus: SectionFocus;
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
  // A nodal MOMENT on an ordinary node is offered on the pure-shell path only
  // (shellPointLoads carries DOFs 3..5). A solid node has three translations
  // only, and the solve refuses a moment on one (KOF-411), so on a solid or
  // mixed model a couple goes through a coupling's reference point.
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
  const renameLoadGroup = useModelStore((s) => s.renameLoadGroup);
  const updateLoadGroup = useModelStore((s) => s.updateLoadGroup);
  const {
    pickTargetGroupId,
    setPickMode,
    allPickedFaces,
    removePickedFace,
    endPick,
    startPickForGroup,
  } = usePickedFaces(onError);
  const text = useT(boundaryMessages);
  const intl = useIntlTag();
  const cadFaces = useModelStore((s) => s.cadFaces);
  const { ready: femReady } = useFemModule();

  // Group whose values are being edited inline (✎), if any.
  const [editingLoadId, setEditingLoadId] = useState<number | null>(
    focusedId(focus),
  );
  useStartOnAdd(focus, () => setPickMode("load", null));
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
  // Whether every picked selection is a coupling's REFERENCE POINT — clicked in
  // the viewport like anything else. Such a point carries rotational DOFs, so
  // it is the one place a MOMENT can act on a solid model: the couple is
  // applied to the point and the coupling spreads it over the gripped surface
  // (rebuildLoads / coupledLoads).
  const refPoints = new Set(couplingGroups.map((c) => c.refNodeId));
  const onlyReferencePoints =
    allPickedFaces.length > 0 &&
    allPickedFaces.every((face) =>
      face.nodeIds.every((id) => refPoints.has(id)),
    );

  const targetLoadGroup =
    pickTargetGroupId !== null
      ? (loadGroups.find((group) => group.id === pickTargetGroupId) ?? null)
      : null;

  function applyLoad() {
    if (allPickedFaces.length === 0) return;
    const faceEntries = toFaceEntries(
      allPickedFaces,
      // eslint-disable-next-line kofem/no-silent-fallback -- numbering offset for the new entries; a pick with no target group starts a fresh group, which has 0 faces
      targetLoadGroup?.faces.length ?? 0,
      pickGeometry,
    );
    if (targetLoadGroup) {
      for (const faceEntry of faceEntries) {
        addFaceToLoadGroup(targetLoadGroup.id, faceEntry);
      }
    } else if (loadKindSel === "pressure") {
      // A pressure is force per unit area, and a single node — a mesh node or a
      // reference point alike — has none. Refuse it here rather than create a
      // group whose selection contributes nothing to the solve.
      if (pickGeometry === "point") {
        onError(text.pressureOnNode);
        return;
      }
      const pressure = parsePressure(pressureVal, onError);
      if (pressure === null) return;
      createLoadGroup(faceEntries, 0, pressure, "pressure");
    } else {
      // A moment needs a rotational DOF to act on. A coupling's reference point
      // has one on every solve path; an ordinary mesh node is offered one only
      // on the pure-shell path (shellPointLoads carries DOFs 3..5). The solve
      // refuses a moment on a solid node rather than drop it (KOF-411).
      if (
        loadKindSel === "moment" &&
        pickGeometry === "point" &&
        !onlyReferencePoints &&
        !isPureShell
      ) {
        onError(text.momentOnSolidNode);
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
    endPick();
  }

  // How the load about to be created will actually reach the solver. The three
  // routes are genuinely different physics — an integrated traction, a
  // concentrated nodal load, and a couple carried by a coupling — so which one
  // a selection lands on is worth saying before it is applied.
  function applicationNote(): string {
    if (loadKindSel === "pressure") return text.notePressure;
    if (loadKindSel === "force") {
      if (onlyReferencePoints) return text.noteForceReference;
      if (pickGeometry === "point") return text.noteForcePoint;
      if (pickGeometry === "edge") return text.noteForceEdge;
      return text.noteForceFace;
    }
    if (onlyReferencePoints) return text.noteMomentReference;
    if (pickGeometry === "point")
      return isPureShell
        ? text.noteMomentShellPoint
        : text.noteMomentSolidPoint;
    return text.noteMomentFace;
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
      {pickMode !== "load" && focus.type === "add" && (
        <button
          className={styles.pickBtn}
          onClick={() => setPickMode("load", null)}
        >
          {text.addLoad}
        </button>
      )}

      {pickMode === "load" && showsPick(focus, pickTargetGroupId) && (
        <div className={styles.pickPanel}>
          <div className={styles.pickPanelHeader}>
            <span className={styles.pickPanelTitle}>
              {targetLoadGroup
                ? text.addFaceTo(targetLoadGroup.name)
                : text.newLoad}
            </span>
            <button
              className={styles.iconBtn}
              onClick={endPick}
              title={text.cancel}
            >
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
              <div className={styles.pickNote}>{applicationNote()}</div>
              <button className={styles.loadBtn} onClick={applyLoad}>
                {text.applyLoad}
              </button>
            </>
          )}

          {allPickedFaces.length > 0 && targetLoadGroup && (
            <button className={styles.loadBtn} onClick={applyLoad}>
              {text.addFaces(allPickedFaces.length)}
            </button>
          )}
        </div>
      )}

      {loadGroups
        .filter((group) => showsItem(focus, group.id))
        .map((group) => (
          <GroupCard
            key={group.id}
            name={group.name}
            meta={loadGroupMeta(group)}
            summary={
              femReady
                ? loadSummaryText(
                    loadFigures(group, cadFaces),
                    group.faces,
                    text,
                    intl,
                  )
                : undefined
            }
            dotClassName={styles.loadDot}
            editTitle={text.editLoad}
            deleteTitle={text.deleteLoad}
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
            onRename={(name) => renameLoadGroup(group.id, name)}
          />
        ))}
    </>
  );
}

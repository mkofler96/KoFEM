// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { useModelStore, referencePointOptions } from "../../store/modelStore";
import type {
  CouplingGroup,
  CouplingKind,
  ReferencePointOption,
} from "../../store/modelStore";
import { usePickedFaces } from "../../hooks/usePickedFaces";
import { DOF_LABELS, toFaceEntries } from "./bcFormUtils";
import {
  CouplingKindSelect,
  DofCheckboxes,
  PickedFaceList,
  ReferencePointInputs,
} from "./BcLoadFormControls";
import { CouplingValueForm } from "./GroupValueForms";
import { GroupCard } from "./GroupCard";
import { fmt } from "../../lib/modelDisplay";
import styles from "./LeftPanel.module.css";

// One-line summary of a coupling: how it ties, and — for a kinematic one — the
// DOFs it ties. A distributing coupling always ties all six, so listing them
// would say nothing.
export function couplingGroupMeta(group: CouplingGroup): string {
  const nNodes = new Set(group.faces.flatMap((face) => face.nodeIds)).size;
  const kind = group.kind === "kinematic" ? "kinematic" : "distributing";
  const dofs =
    group.kind === "kinematic"
      ? ` · ${group.dofs.map((dof) => DOF_LABELS[dof]).join(", ")}`
      : "";
  return `${kind}${dofs} · ${nNodes} node${nNodes === 1 ? "" : "s"} → (${group.point
    .map((c) => fmt(c))
    .join(", ")})`;
}

// Parse the reference point's coordinate boxes. A point at the origin is
// perfectly valid, so only non-finite input is rejected — never coerced to 0,
// which would silently move the coupling somewhere the user did not ask for.
function parsePoint(
  coords: [string, string, string],
  onError: (msg: string) => void,
): [number, number, number] | null {
  const parsed = coords.map((c) => parseFloat(c));
  if (parsed.some((c) => !isFinite(c))) {
    onError("Each reference point coordinate must be a finite number");
    return null;
  }
  return [parsed[0], parsed[1], parsed[2]];
}

// Surface-to-point coupling section: pick the surface, choose how it ties to its
// reference point and where that point sits, then apply. The same shape as a BC
// or a load, because a coupling is model data just like they are.
export function CouplingSection({
  onError,
}: {
  onError(msg: string | null): void;
}) {
  const nodes = useModelStore((s) => s.nodes);
  const elements = useModelStore((s) => s.elements);
  const couplingGroups = useModelStore((s) => s.couplingGroups);
  const pickMode = useModelStore((s) => s.pickMode);
  const createCouplingGroup = useModelStore((s) => s.createCouplingGroup);
  const addFaceToCouplingGroup = useModelStore((s) => s.addFaceToCouplingGroup);
  const updateCouplingGroup = useModelStore((s) => s.updateCouplingGroup);
  const removeFaceFromCouplingGroup = useModelStore(
    (s) => s.removeFaceFromCouplingGroup,
  );
  const deleteCouplingGroup = useModelStore((s) => s.deleteCouplingGroup);
  const {
    pickTargetGroupId,
    setPickMode,
    allPickedFaces,
    removePickedFace,
    endPick,
    startPickForGroup,
  } = usePickedFaces(onError);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [kind, setKind] = useState<CouplingKind>("kinematic");
  const [checkedDofs, setCheckedDofs] = useState([
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
  const [coords, setCoords] = useState<[string, string, string]>([
    "0",
    "0",
    "0",
  ]);
  // Which derived position the coordinates were last filled from, so the boxes
  // follow the pick until the user types their own numbers.
  const [placedLabel, setPlacedLabel] = useState<string | null>(null);

  const targetGroup =
    pickTargetGroupId !== null
      ? (couplingGroups.find((group) => group.id === pickTargetGroupId) ?? null)
      : null;

  // Positions derived from the surface picked so far — its centre, plus the two
  // ends of its axis when it is a cylinder (KOF-208).
  const options = useMemo(
    () => referencePointOptions(allPickedFaces, nodes, elements),
    [allPickedFaces, nodes, elements],
  );
  // Default the point to the surface centre as soon as one is picked, and keep
  // following it while more faces are added — until the user picks another
  // position or types coordinates, at which point the boxes are theirs.
  const centre = options.length > 0 ? options[0] : null;
  const centreKey = centre ? centre.point.join(",") : "";
  const [followedCentre, setFollowedCentre] = useState("");
  if (centre && placedLabel === null && centreKey !== followedCentre) {
    setFollowedCentre(centreKey);
    setCoords([
      String(centre.point[0]),
      String(centre.point[1]),
      String(centre.point[2]),
    ]);
  }

  function placeAt(option: ReferencePointOption) {
    setPlacedLabel(option.label);
    setCoords([
      String(option.point[0]),
      String(option.point[1]),
      String(option.point[2]),
    ]);
  }

  function startCouplingPick(groupId: number | null) {
    setPlacedLabel(null);
    setFollowedCentre("");
    if (groupId === null) setPickMode("coupling", null);
    else startPickForGroup("coupling", groupId);
  }

  function applyCoupling() {
    if (allPickedFaces.length === 0) {
      onError("A coupling needs at least one picked face");
      return;
    }
    if (targetGroup) {
      for (const faceEntry of toFaceEntries(
        allPickedFaces,
        targetGroup.faces.length,
      ))
        addFaceToCouplingGroup(targetGroup.id, faceEntry);
      endPick();
      return;
    }
    const point = parsePoint(coords, onError);
    if (point === null) return;
    const dofs = checkedDofs
      .map((checked, i) => (checked ? i : -1))
      .filter((i) => i >= 0);
    if (kind === "kinematic" && dofs.length === 0) {
      onError("A kinematic coupling must tie at least one DOF");
      return;
    }
    createCouplingGroup(toFaceEntries(allPickedFaces, 0), point, kind, dofs);
    endPick();
  }

  return (
    <>
      <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
        Couplings
      </div>

      {pickMode !== "coupling" && (
        <button
          className={styles.pickBtn}
          data-testid="add-coupling"
          onClick={() => startCouplingPick(null)}
        >
          + Add Coupling
        </button>
      )}

      {pickMode === "coupling" && (
        <div className={styles.pickPanel}>
          <div className={styles.pickPanelHeader}>
            <span className={styles.pickPanelTitle}>
              {targetGroup ? `Add face to ${targetGroup.name}` : "New Coupling"}
            </span>
            <button className={styles.iconBtn} onClick={endPick} title="Cancel">
              ✕
            </button>
          </div>

          <PickedFaceList faces={allPickedFaces} onRemove={removePickedFace} />

          {!targetGroup && allPickedFaces.length > 0 && (
            <>
              <CouplingKindSelect value={kind} onChange={setKind} />
              {/* The DOF mask only exists for a kinematic coupling — a
                  distributing one ties all six of its reference point's DOFs by
                  construction, so offering checkboxes would promise a control
                  the solver does not have. */}
              {kind === "kinematic" && (
                <DofCheckboxes
                  checkedDofs={checkedDofs}
                  showRotations
                  onToggle={(index) =>
                    setCheckedDofs((prev) =>
                      prev.map((checked, i) =>
                        i === index ? !checked : checked,
                      ),
                    )
                  }
                />
              )}
              <ReferencePointInputs
                options={options}
                coords={coords}
                onCoordChange={(index, value) => {
                  setPlacedLabel("custom");
                  setCoords((prev) => {
                    const next = [...prev] as [string, string, string];
                    next[index] = value;
                    return next;
                  });
                }}
                onPickOption={placeAt}
              />
            </>
          )}

          <button
            className={styles.primaryBtn}
            data-testid="apply-coupling"
            onClick={applyCoupling}
          >
            {targetGroup ? "Add Face" : "Apply Coupling"}
          </button>
        </div>
      )}

      {couplingGroups.map((group) => (
        <GroupCard
          key={group.id}
          name={group.name}
          meta={couplingGroupMeta(group)}
          dotClassName={styles.couplingDot}
          editTitle="Edit coupling"
          deleteTitle="Delete coupling"
          faces={group.faces}
          editForm={
            editingId === group.id && (
              <CouplingValueForm
                group={group}
                onSave={(nextKind, nextDofs, nextPoint) => {
                  updateCouplingGroup(group.id, nextKind, nextDofs, nextPoint);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            )
          }
          onStartPick={() => startCouplingPick(group.id)}
          onToggleEdit={() =>
            setEditingId(editingId === group.id ? null : group.id)
          }
          onDelete={() => deleteCouplingGroup(group.id)}
          onRemoveFace={(faceId) =>
            removeFaceFromCouplingGroup(group.id, faceId)
          }
        />
      ))}
    </>
  );
}

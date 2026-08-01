// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import {
  useModelStore,
  tieFaces,
  DEFAULT_TIE_DISTANCE,
} from "../../store/modelStore";
import type { TieExtent, TieGroup, TieSide } from "../../store/modelStore";
import { usePickedFaces } from "../../hooks/usePickedFaces";
import { useTiePairs } from "../../hooks/useTiePairs";
import { parseTieDistance, toFaceEntries } from "./bcFormUtils";
import { PickedFaceList, TieExtentInputs } from "./BcLoadFormControls";
import { TieValueForm } from "./GroupValueForms";
import styles from "./LeftPanel.module.css";

const SIDE_LABEL: Record<TieSide, string> = {
  a: "Surface A",
  b: "Surface B",
};

// A connection with no Surface B is one picked interface split by body — see
// applyTie.
export function isSelfSplitTie(group: TieGroup): boolean {
  return group.facesB.length === 0;
}

// One-line summary of what a connection couples and how far it reaches.
export function tieGroupMeta(group: TieGroup, nPaired: number): string {
  const extent =
    group.extent === "full"
      ? "full surface"
      : `within ${group.searchDistance} mm`;
  const split = isSelfSplitTie(group) ? " · split by body" : "";
  return `${extent}${split} · ${nPaired} node pair${nPaired === 1 ? "" : "s"}`;
}

// Tie connections section: pick the two surfaces a connection joins, choose
// whether it couples them whole or only where they come within a distance, and
// list the existing connections with their inline editors — the same shape as a
// BC or a load, because a connection is model data just like they are.
export function TieSection({ onError }: { onError(msg: string | null): void }) {
  const tieGroups = useModelStore((s) => s.tieGroups);
  const pickMode = useModelStore((s) => s.pickMode);
  const pickTieSide = useModelStore((s) => s.pickTieSide);
  const setPickTieSide = useModelStore((s) => s.setPickTieSide);
  const tieDraft = useModelStore((s) => s.tieDraft);
  const createTieGroup = useModelStore((s) => s.createTieGroup);
  const addFaceToTieGroup = useModelStore((s) => s.addFaceToTieGroup);
  const updateTieGroup = useModelStore((s) => s.updateTieGroup);
  const removeFaceFromTieGroup = useModelStore((s) => s.removeFaceFromTieGroup);
  const deleteTieGroup = useModelStore((s) => s.deleteTieGroup);
  const {
    pickTargetGroupId,
    setPickMode,
    allPickedFaces,
    removePickedFace,
    endPick,
  } = usePickedFaces(onError);
  const { reports } = useTiePairs();

  // Connection whose values are being edited inline (✎), if any.
  const [editingTieId, setEditingTieId] = useState<number | null>(null);
  const [extent, setExtent] = useState<TieExtent>("full");
  const [distance, setDistance] = useState(String(DEFAULT_TIE_DISTANCE));

  const targetTieGroup =
    pickTargetGroupId !== null
      ? (tieGroups.find((group) => group.id === pickTargetGroupId) ?? null)
      : null;

  // The side being picked lives in the live face-pick session; the other one is
  // parked in the draft, so both stay visible (and highlighted) at once.
  const pickedOf = (side: TieSide) =>
    side === pickTieSide ? allPickedFaces : tieDraft[side];

  function startTiePick(groupId: number | null, side: TieSide) {
    setPickMode("tie", groupId);
    setPickTieSide(side);
  }

  function applyTie() {
    if (targetTieGroup) {
      if (allPickedFaces.length === 0) return;
      const faceEntries = toFaceEntries(
        allPickedFaces,
        tieFaces(targetTieGroup, pickTieSide).length,
      );
      for (const faceEntry of faceEntries)
        addFaceToTieGroup(targetTieGroup.id, pickTieSide, faceEntry);
      endPick();
      return;
    }

    // Surface B may be left empty: where two parts meet across a coincident
    // interface (a pin in a hook eye) the mesher gives the two surfaces one CAD
    // face, so a single pick IS both sides and the tie separates them by body
    // (tieSides). Picking both sides stays the way to tie surfaces that really
    // are distinct.
    const facesA = pickedOf("a");
    const facesB = pickedOf("b");
    if (facesA.length === 0) {
      onError("A tie needs at least one picked face on Surface A");
      return;
    }
    let searchDistance = 0;
    if (extent === "region") {
      const parsed = parseTieDistance(distance, onError);
      if (parsed === null) return;
      searchDistance = parsed;
    }
    createTieGroup(
      toFaceEntries(facesA, 0),
      toFaceEntries(facesB, 0),
      extent,
      searchDistance,
    );
    endPick();
  }

  return (
    <>
      <div className={styles.sectionLabel} style={{ marginTop: 16 }}>
        Tie connections
      </div>

      {pickMode !== "tie" && (
        <button
          className={styles.pickBtn}
          data-testid="add-tie"
          onClick={() => startTiePick(null, "a")}
        >
          + Add Tie
        </button>
      )}

      {pickMode === "tie" && (
        <div className={styles.pickPanel}>
          <div className={styles.pickPanelHeader}>
            <span className={styles.pickPanelTitle}>
              {targetTieGroup
                ? `Add face to ${targetTieGroup.name}`
                : "New Tie"}
            </span>
            <button className={styles.iconBtn} onClick={endPick} title="Cancel">
              ✕
            </button>
          </div>

          {/* A connection joins TWO surfaces, so the pick fills one side at a
              time; switching parks the current side and brings the other back. */}
          <div
            className={styles.segToggle}
            role="group"
            aria-label="Tie surface"
          >
            {(["a", "b"] as const).map((side) => (
              <button
                key={side}
                type="button"
                data-testid={`tie-side-${side}`}
                className={`${styles.segBtn} ${pickTieSide === side ? styles.segBtnActive : ""}`}
                aria-pressed={pickTieSide === side}
                onClick={() => setPickTieSide(side)}
              >
                {SIDE_LABEL[side]}
                {pickedOf(side).length > 0 ? ` (${pickedOf(side).length})` : ""}
              </button>
            ))}
          </div>

          <PickedFaceList faces={allPickedFaces} onRemove={removePickedFace} />

          {!targetTieGroup && (
            <>
              <TieExtentInputs
                extent={extent}
                distance={distance}
                onExtentChange={setExtent}
                onDistanceChange={setDistance}
              />
              <div className={styles.pickNote}>
                {extent === "full"
                  ? "every node pair across the two surfaces is welded"
                  : "only node pairs closer than the search distance are welded"}
              </div>
              {pickedOf("b").length === 0 && (
                <div className={styles.pickNote}>
                  leave Surface B empty to tie one picked interface, split
                  between the two bodies that meet on it
                </div>
              )}
            </>
          )}

          <button
            className={styles.primaryBtn}
            data-testid="apply-tie"
            onClick={applyTie}
          >
            {targetTieGroup ? "Add Face" : "Apply Tie"}
          </button>
        </div>
      )}

      {tieGroups.map((group, index) => (
        <div className={styles.bcGroup} key={group.id}>
          <div className={styles.bcGroupHeader}>
            <span className={styles.tieDot} />
            <span className={styles.bcGroupName}>{group.name}</span>
            <span className={styles.bcGroupMeta}>
              {tieGroupMeta(group, reports[index].nPaired)}
            </span>
            <div className={styles.treeItemActions}>
              <button
                className={styles.iconBtn}
                title="Edit tie"
                onClick={() =>
                  setEditingTieId(editingTieId === group.id ? null : group.id)
                }
              >
                ✎
              </button>
              <button
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                title="Delete tie"
                onClick={() => deleteTieGroup(group.id)}
              >
                ✕
              </button>
            </div>
          </div>

          {editingTieId === group.id && (
            <TieValueForm
              group={group}
              onSave={(nextExtent, nextDistance) => {
                updateTieGroup(group.id, nextExtent, nextDistance);
                setEditingTieId(null);
              }}
              onCancel={() => setEditingTieId(null)}
            />
          )}

          {/* The two surfaces are listed separately — which face sits on which
              side is the whole content of a connection. A self-split tie has
              only the one interface to show. */}
          {(isSelfSplitTie(group)
            ? (["a"] as const)
            : (["a", "b"] as const)
          ).map((side) => (
            <div key={side}>
              <div className={styles.tieSideRow}>
                <span className={styles.bcFaceIndent}>└</span>
                <span className={styles.tieSideLabel}>
                  {isSelfSplitTie(group) ? "Interface" : SIDE_LABEL[side]}
                </span>
                <button
                  className={styles.iconBtn}
                  title={`Add face to ${SIDE_LABEL[side]}`}
                  data-testid={`tie-add-face-${group.id}-${side}`}
                  onClick={() => startTiePick(group.id, side)}
                >
                  +
                </button>
              </div>
              {tieFaces(group, side).map((face) => (
                <div key={face.id} className={styles.bcFaceRow}>
                  <span className={styles.bcFaceIndent}>└</span>
                  <span className={styles.bcFaceName}>{face.label}</span>
                  <button
                    className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                    title="Remove face"
                    onClick={() =>
                      removeFaceFromTieGroup(group.id, side, face.id)
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

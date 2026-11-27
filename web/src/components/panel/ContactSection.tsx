// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore, contactFaces } from "../../store/modelStore";
import type { ContactGroup, TieSide } from "../../store/modelStore";
import { usePickedFaces } from "../../hooks/usePickedFaces";
import { toFaceEntries } from "./bcFormUtils";
import { PickedFaceList } from "./BcLoadFormControls";
import { requestDelete } from "../../store/confirmDelete";
import { useIntlTag, useT } from "../../i18n/useLocale";
import { boundaryMessages } from "../../i18n/messages/boundary";
import { contactSummaryOf } from "../../lib/contact";
import styles from "./Panel.module.css";
import {
  showsItem,
  showsPick,
  useStartOnAdd,
  type SectionFocus,
} from "./sectionFocus";

// Contact section (KOF-485): pick the two surfaces a contact is between, and
// show each contact with its surfaces and, after a solve, where it touched and
// what it carried. A contact has nothing to set: the solve finds where the
// surfaces touch.
export function ContactSection({
  onError,
  focus,
}: {
  onError(msg: string | null): void;
  focus: SectionFocus;
}) {
  const contactGroups = useModelStore((s) => s.contactGroups);
  const pickMode = useModelStore((s) => s.pickMode);
  const pickTieSide = useModelStore((s) => s.pickTieSide);
  const setPickTieSide = useModelStore((s) => s.setPickTieSide);
  const tieDraft = useModelStore((s) => s.tieDraft);
  const createContactGroup = useModelStore((s) => s.createContactGroup);
  const addFaceToContactGroup = useModelStore((s) => s.addFaceToContactGroup);
  const removeFaceFromContactGroup = useModelStore(
    (s) => s.removeFaceFromContactGroup,
  );
  const deleteContactGroup = useModelStore((s) => s.deleteContactGroup);
  const contactResult = useModelStore((s) => s.result?.contact ?? null);
  const {
    pickTargetGroupId,
    setPickMode,
    allPickedFaces,
    removePickedFace,
    endPick,
  } = usePickedFaces(onError);
  const text = useT(boundaryMessages);
  const intlTag = useIntlTag();
  const sideLabel: Record<TieSide, string> = {
    a: text.surfaceA,
    b: text.surfaceB,
  };

  const targetGroup =
    pickTargetGroupId !== null
      ? (contactGroups.find((group) => group.id === pickTargetGroupId) ?? null)
      : null;

  // The side being picked lives in the live pick session; the other one is
  // parked in the draft, so both stay visible at once.
  const pickedOf = (side: TieSide) =>
    side === pickTieSide ? allPickedFaces : tieDraft[side];

  function startPick(groupId: number | null, side: TieSide) {
    setPickMode("contact", groupId);
    setPickTieSide(side);
  }

  useStartOnAdd(focus, () => startPick(null, "a"));

  function apply() {
    if (targetGroup) {
      if (allPickedFaces.length === 0) return;
      const entries = toFaceEntries(
        allPickedFaces,
        contactFaces(targetGroup, pickTieSide).length,
        "face",
      );
      for (const entry of entries)
        addFaceToContactGroup(targetGroup.id, pickTieSide, entry);
      endPick();
      return;
    }
    const facesA = pickedOf("a");
    const facesB = pickedOf("b");
    if (facesA.length === 0 || facesB.length === 0) {
      onError(text.contactNeedsBothSurfaces);
      return;
    }
    createContactGroup(
      toFaceEntries(facesA, 0, "face"),
      toFaceEntries(facesB, 0, "face"),
    );
    endPick();
  }

  // What the last solve found at `group`; nothing before a solve.
  function summary(group: ContactGroup) {
    if (contactResult === null) return null;
    const { touching, total, force } = contactSummaryOf(group, contactResult);
    return (
      <div
        className={styles.contactSummary}
        data-testid={`contact-summary-${group.id}`}
      >
        {text.contactSummary(
          touching,
          total,
          force.toLocaleString(intlTag, { maximumSignificantDigits: 4 }),
        )}
      </div>
    );
  }

  return (
    <>
      {pickMode !== "contact" && focus.type === "add" && (
        <button
          className={styles.pickBtn}
          data-testid="add-contact"
          onClick={() => startPick(null, "a")}
        >
          {text.addContact}
        </button>
      )}

      {pickMode === "contact" && showsPick(focus, pickTargetGroupId) && (
        <div className={styles.pickPanel}>
          <div className={styles.pickPanelHeader}>
            <span className={styles.pickPanelTitle}>
              {targetGroup
                ? text.addFaceTo(targetGroup.name)
                : text.newContactForm}
            </span>
            <button
              className={styles.iconBtn}
              onClick={endPick}
              title={text.cancel}
            >
              ✕
            </button>
          </div>

          {!targetGroup && (
            <div
              className={styles.segToggle}
              role="group"
              aria-label={text.contactSurface}
            >
              {(["a", "b"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  data-testid={`contact-side-${side}`}
                  className={`${styles.segBtn} ${pickTieSide === side ? styles.segBtnActive : ""}`}
                  aria-pressed={pickTieSide === side}
                  onClick={() => setPickTieSide(side)}
                >
                  {sideLabel[side]}
                  {pickedOf(side).length > 0
                    ? ` (${pickedOf(side).length})`
                    : ""}
                </button>
              ))}
            </div>
          )}

          <PickedFaceList
            faces={allPickedFaces}
            onRemove={removePickedFace}
            geometry="face"
          />

          {!targetGroup && (
            <>
              <div className={styles.pickNote}>{text.noteContact}</div>
              <div className={styles.pickNote}>{text.noteContactScope}</div>
            </>
          )}

          <button
            className={styles.primaryBtn}
            data-testid="apply-contact"
            onClick={apply}
          >
            {targetGroup ? text.addFaces(1) : text.applyContact}
          </button>
        </div>
      )}

      {contactGroups.map((group) =>
        !showsItem(focus, group.id) ? null : (
          <div className={styles.bcGroup} key={group.id}>
            <div className={styles.bcGroupHeader}>
              <span className={styles.contactDot} />
              <span className={styles.bcGroupName}>{group.name}</span>
              <span className={styles.bcGroupMeta}>
                {text.contactMeta(group.facesA.length + group.facesB.length)}
              </span>
              <div className={styles.treeItemActions}>
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  title={text.deleteContact}
                  onClick={() =>
                    requestDelete(group.name, () =>
                      deleteContactGroup(group.id),
                    )
                  }
                >
                  ✕
                </button>
              </div>
            </div>

            {summary(group)}

            {(["a", "b"] as const).map((side) => (
              <div key={side}>
                <div className={styles.tieSideRow}>
                  <span className={styles.bcFaceIndent}>└</span>
                  <span className={styles.tieSideLabel}>{sideLabel[side]}</span>
                  <button
                    className={styles.iconBtn}
                    title={text.addFaceTo(sideLabel[side])}
                    data-testid={`contact-add-face-${group.id}-${side}`}
                    onClick={() => startPick(group.id, side)}
                  >
                    +
                  </button>
                </div>
                {contactFaces(group, side).map((face) => (
                  <div key={face.id} className={styles.bcFaceRow}>
                    <span className={styles.bcFaceIndent}>└</span>
                    <span className={styles.bcFaceName}>{face.label}</span>
                    <button
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      title={text.removeFace}
                      onClick={() =>
                        removeFaceFromContactGroup(group.id, side, face.id)
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ),
      )}
    </>
  );
}

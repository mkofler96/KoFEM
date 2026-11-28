// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useState, type ReactNode } from "react";
import type { BcFaceEntry } from "../../store/modelStore";
import type { SummaryText } from "../../lib/groupSummary";
import { requestDelete } from "../../store/confirmDelete";
import { useT } from "../../i18n/useLocale";
import { boundaryMessages } from "../../i18n/messages/boundary";
import styles from "./Panel.module.css";

// One entry in the BC / load group list: name + summary header with the
// add-face / edit / delete actions, the Name field when the group can be
// renamed, an optional inline edit form, and the group's face rows. Shared by
// BcSection, LoadSection and CouplingSection. Supports and loads also say
// what they apply (KOF-494): area, DOFs held, total force and traction.
export function GroupCard({
  name,
  meta,
  summary,
  dotClassName,
  editTitle,
  deleteTitle,
  faces,
  editForm,
  onStartPick,
  onToggleEdit,
  onDelete,
  onRemoveFace,
  onRename,
}: {
  name: string;
  meta: string;
  // Absent on groups that have none, and while the Rust module loads.
  summary?: SummaryText;
  dotClassName: string;
  editTitle: string;
  deleteTitle: string;
  faces: BcFaceEntry[];
  editForm: ReactNode;
  onStartPick(): void;
  onToggleEdit(): void;
  onDelete(): void;
  onRemoveFace(faceId: number): void;
  // Given a trimmed, non-blank name. Absent: the group has no Name field.
  onRename?(name: string): void;
}) {
  const text = useT(boundaryMessages);
  return (
    <div className={styles.bcGroup}>
      <div className={styles.bcGroupHeader}>
        <span className={dotClassName} />
        <span className={styles.bcGroupName}>{name}</span>
        <span className={styles.bcGroupMeta}>{meta}</span>
        <div className={styles.treeItemActions}>
          <button
            className={styles.iconBtn}
            title={text.addFace}
            onClick={onStartPick}
          >
            +
          </button>
          <button
            className={styles.iconBtn}
            title={editTitle}
            onClick={onToggleEdit}
          >
            ✎
          </button>
          <button
            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
            title={deleteTitle}
            onClick={() => requestDelete(name, onDelete)}
          >
            ✕
          </button>
        </div>
      </div>
      {summary && (
        <div className={styles.bcGroupSummary} data-testid="group-summary">
          <div>{summary.summary}</div>
          {summary.warning && (
            <div
              className={styles.bcGroupWarning}
              data-testid="group-summary-warning"
            >
              {summary.warning}
            </div>
          )}
        </div>
      )}
      {onRename && <GroupNameField name={name} onRename={onRename} />}
      {editForm}
      {faces.map((face) => (
        <div key={face.id} className={styles.bcFaceRow}>
          <span className={styles.bcFaceIndent}>└</span>
          <span className={styles.bcFaceName}>{face.label}</span>
          <button
            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
            title={text.removeFace}
            onClick={() => onRemoveFace(face.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// The group's name, renamed as the user types (KOF-339): the model tree and the
// panel title follow each keystroke. A blank name is never applied; the group
// keeps its last name and the field says so until a name is typed.
function GroupNameField({
  name,
  onRename,
}: {
  name: string;
  onRename(name: string): void;
}) {
  const [draft, setDraft] = useState(name);
  const inputId = useId();
  const blank = draft.trim() === "";
  const text = useT(boundaryMessages);
  return (
    <div className={styles.groupNameRow}>
      <div className={styles.formRow}>
        <label className={styles.formLabel} htmlFor={inputId}>
          {text.name}
        </label>
        <input
          id={inputId}
          className={styles.formInput}
          data-testid="group-name"
          value={draft}
          aria-invalid={blank}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value.trim() !== "") onRename(e.target.value.trim());
          }}
        />
      </div>
      {blank && (
        <div className={styles.fieldError} data-testid="group-name-error">
          {text.blankName(name)}
        </div>
      )}
    </div>
  );
}

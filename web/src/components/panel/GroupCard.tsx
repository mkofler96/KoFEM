// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useId, useState, type ReactNode } from "react";
import type { BcFaceEntry } from "../../store/modelStore";
import styles from "./Panel.module.css";

// One entry in the BC / load group list: name + summary header with the
// add-face / edit / delete actions, the Name field when the group can be
// renamed, an optional inline edit form, and the group's face rows. Shared by
// BcSection, LoadSection and CouplingSection.
export function GroupCard({
  name,
  meta,
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
  return (
    <div className={styles.bcGroup}>
      <div className={styles.bcGroupHeader}>
        <span className={dotClassName} />
        <span className={styles.bcGroupName}>{name}</span>
        <span className={styles.bcGroupMeta}>{meta}</span>
        <div className={styles.treeItemActions}>
          <button
            className={styles.iconBtn}
            title="Add face"
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
            onClick={onDelete}
          >
            ✕
          </button>
        </div>
      </div>
      {onRename && <GroupNameField name={name} onRename={onRename} />}
      {editForm}
      {faces.map((face) => (
        <div key={face.id} className={styles.bcFaceRow}>
          <span className={styles.bcFaceIndent}>└</span>
          <span className={styles.bcFaceName}>{face.label}</span>
          <button
            className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
            title="Remove face"
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
  return (
    <div className={styles.groupNameRow}>
      <div className={styles.formRow}>
        <label className={styles.formLabel} htmlFor={inputId}>
          Name
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
          A name can&apos;t be blank. It stays “{name}” until you type one.
        </div>
      )}
    </div>
  );
}

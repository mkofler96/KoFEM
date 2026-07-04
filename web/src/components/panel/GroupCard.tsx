// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import type { BcFaceEntry } from "../../store/modelStore";
import styles from "./LeftPanel.module.css";

// One entry in the BC / load group list: name + summary header with the
// add-face / edit / delete actions, an optional inline edit form, and the
// group's face rows. Shared by BcSection and LoadSection.
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

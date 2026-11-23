// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import {
  answerDelete,
  useConfirmDelete,
  type DeleteRequest,
} from "../store/confirmDelete";
import styles from "./CgContinuationDialog.module.css";

export function ConfirmDeleteDialog() {
  const pending = useConfirmDelete((s) => s.pending);
  return pending ? <DeletePrompt request={pending} /> : null;
}

function DeletePrompt({ request }: { request: DeleteRequest }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [dontAsk, setDontAsk] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) throw new Error("Delete confirmation dialog did not mount");
    if (!dialog.open) dialog.showModal();
    cancelRef.current?.focus();
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby="confirm-delete-title"
      onCancel={(event) => {
        event.preventDefault();
        answerDelete(false, false);
      }}
    >
      <h2 id="confirm-delete-title">Delete {request.name}?</h2>
      <p>This cannot be undone.</p>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={dontAsk}
          onChange={(event) => setDontAsk(event.target.checked)}
        />
        {"Don't ask again this session"}
      </label>
      <div className={styles.actions}>
        <button
          ref={cancelRef}
          type="button"
          onClick={() => answerDelete(false, false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.danger}
          onClick={() => answerDelete(true, dontAsk)}
        >
          Delete
        </button>
      </div>
    </dialog>
  );
}

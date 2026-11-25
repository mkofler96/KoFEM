// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import {
  answerDelete,
  useConfirmDelete,
  type DeleteRequest,
} from "../store/confirmDelete";
import { useT } from "../i18n/useLocale";
import { dialogMessages } from "../i18n/messages/dialogs";
import styles from "./CgContinuationDialog.module.css";

export function ConfirmDeleteDialog() {
  const pending = useConfirmDelete((s) => s.pending);
  return pending ? <DeletePrompt request={pending} /> : null;
}

function DeletePrompt({ request }: { request: DeleteRequest }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [dontAsk, setDontAsk] = useState(false);
  const text = useT(dialogMessages);
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
      <h2 id="confirm-delete-title">{text.deleteTitle(request.name)}</h2>
      <p>{text.cannotUndo}</p>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={dontAsk}
          onChange={(event) => setDontAsk(event.target.checked)}
        />
        {text.dontAskAgain}
      </label>
      <div className={styles.actions}>
        <button
          ref={cancelRef}
          type="button"
          onClick={() => answerDelete(false, false)}
        >
          {text.cancel}
        </button>
        <button
          type="button"
          className={styles.danger}
          onClick={() => answerDelete(true, dontAsk)}
        >
          {text.delete}
        </button>
      </div>
    </dialog>
  );
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Deleting a support, load, tie or coupling asks first. "Don't ask again"
// lasts until the page reloads, so it is kept here and not in the model or a
// saved file.

import { create } from "zustand";

export interface DeleteRequest {
  name: string;
  run: () => void;
}

interface ConfirmDeleteState {
  pending: DeleteRequest | null;
  skipForSession: boolean;
}

export const useConfirmDelete = create<ConfirmDeleteState>(() => ({
  pending: null,
  skipForSession: false,
}));

// Delete `name` now if the user turned the question off, else ask.
export function requestDelete(name: string, run: () => void): void {
  const { pending, skipForSession } = useConfirmDelete.getState();
  if (skipForSession) {
    run();
    return;
  }
  if (pending)
    throw new Error(
      `cannot ask to delete ${name}: already asking about ${pending.name}`,
    );
  useConfirmDelete.setState({ pending: { name, run } });
}

export function answerDelete(confirmed: boolean, dontAskAgain: boolean): void {
  const { pending } = useConfirmDelete.getState();
  if (!pending) throw new Error("no delete is waiting for an answer");
  useConfirmDelete.setState({
    pending: null,
    skipForSession: confirmed && dontAskAgain,
  });
  if (confirmed) pending.run();
}

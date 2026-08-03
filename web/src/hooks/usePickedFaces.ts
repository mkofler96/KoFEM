// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useModelStore } from "../store/modelStore";
import type { PickMode } from "../store/modelStore";

// Shared face-picking session state: the viewport writes clicked faces into
// the store (selectedFace + shift-click pendingFaces); both pick panels read
// and clear it through this hook.
export function usePickedFaces(onError: (msg: string | null) => void) {
  const pickTargetGroupId = useModelStore((s) => s.pickTargetGroupId);
  const setPickMode = useModelStore((s) => s.setPickMode);
  const selectedFace = useModelStore((s) => s.selectedFace);
  const setSelectedFace = useModelStore((s) => s.setSelectedFace);
  const pendingFaces = useModelStore((s) => s.pendingFaces);
  const setPendingFaces = useModelStore((s) => s.setPendingFaces);

  const allPickedFaces = selectedFace
    ? [...pendingFaces, selectedFace]
    : pendingFaces;

  function removePickedFace(index: number) {
    if (index < pendingFaces.length) {
      setPendingFaces(pendingFaces.filter((_, i) => i !== index));
    } else {
      setSelectedFace(null);
    }
  }

  // Leave the pick session — used both on cancel and after a successful apply.
  function endPick() {
    onError(null);
    setPickMode(null);
    setSelectedFace(null);
    setPendingFaces([]);
  }

  function startPickForGroup(kind: PickMode, groupId: number) {
    setPickMode(kind, groupId);
    setSelectedFace(null);
    setPendingFaces([]);
  }

  return {
    pickTargetGroupId,
    setPickMode,
    allPickedFaces,
    removePickedFace,
    endPick,
    startPickForGroup,
  };
}

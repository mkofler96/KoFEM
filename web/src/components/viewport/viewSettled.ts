// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { addTail, type RootState } from "@react-three/fiber";
import { applyPendingSceneCommits } from "./pickingEvents";

// Resolves once the viewport shows the store as it is now: the scene's React
// tree has applied every pending change, that state has been drawn, and
// nothing asks for another frame. Draws nothing itself.
export function viewSettled(get: () => RootState): Promise<void> {
  // The scene's tree applies a store change in a scheduled task (see
  // pickingEvents); apply it now, effects included.
  applyPendingSceneCommits();
  // Whatever needs drawing has asked for a frame by now. With none asked
  // for, the canvas already shows this state.
  if (get().internal.frames === 0) return Promise.resolve();
  // R3F runs its tail callbacks when a frame finds nothing left to draw and
  // the render loop stops.
  return new Promise<void>((resolve) => {
    const unsubscribe = addTail(() => {
      unsubscribe();
      resolve();
    });
  });
}

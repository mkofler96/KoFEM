// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { events as pointerEvents } from "@react-three/fiber";
import type { EventManager } from "@react-three/fiber";

// R3F's own store type (it bundles a different zustand than the app).
type R3FStore = Parameters<typeof pointerEvents>[0];

// R3F's pointer events, raycasting against the scene as it is now.
//
// The viewport renders on demand (frameloop="demand"). World matrices are
// refreshed when a frame renders, so after a camera move or a newly placed
// marker they lag until the next frame, and a click that arrives first would
// raycast from the old camera pose against old object positions and pick
// nothing, or the wrong face. Updating them before each raycast makes picking
// independent of whether a frame has run; the scene is small, so this is cheap.
export function pickingEvents(store: R3FStore): EventManager<HTMLElement> {
  const base = pointerEvents(store);
  const compute = base.compute;
  if (!compute)
    throw new Error("R3F pointer events have no compute function to wrap");
  return {
    ...base,
    compute(event, state, previous) {
      state.scene.updateMatrixWorld();
      state.camera.updateMatrixWorld();
      compute(event, state, previous);
    },
  };
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { events as pointerEvents, flushSync } from "@react-three/fiber";
import type { EventManager } from "@react-three/fiber";

// R3F's own store type (it bundles a different zustand than the app).
type R3FStore = Parameters<typeof pointerEvents>[0];
type Handlers = NonNullable<EventManager<HTMLElement>["handlers"]>;

// Apply what the scene's React tree still has pending, now. R3F's flushSync
// runs its callback and then every commit that waits; the commits are what is
// wanted, so the callback has nothing to do.
export function applyPendingSceneCommits(): void {
  flushSync(() => undefined);
}

// R3F's pointer events, raycasting against the scene as it is now.
//
// The viewport renders on demand (frameloop="demand"). World matrices are
// refreshed when a frame renders, so after a camera move or a newly placed
// marker they lag until the next frame, and a click that arrives first would
// raycast from the old camera pose against old object positions and pick
// nothing, or the wrong face. Updating them before each raycast makes picking
// independent of whether a frame has run; the scene is small, so this is cheap.
//
// The scene's React tree lags the store the same way. R3F's renderer commits a
// store change (a pick session starting, a face just picked) in a scheduled
// task, and the browser runs input that is already waiting first. A click that
// came before that commit found the surface without its pick handler, or ran
// a handler that still held the selection from before the last pick and
// dropped it. Flushing the pending commit before each event lets the handlers
// see the store as it is.
export function pickingEvents(store: R3FStore): EventManager<HTMLElement> {
  const base = pointerEvents(store);
  const compute = base.compute;
  if (!compute)
    throw new Error("R3F pointer events have no compute function to wrap");
  if (!base.handlers)
    throw new Error("R3F pointer events have no handlers to wrap");
  const handlers = Object.fromEntries(
    Object.entries(base.handlers).map(([name, handle]) => [
      name,
      (event: Event) => {
        applyPendingSceneCommits();
        handle(event);
      },
    ]),
  ) as Handlers;
  return {
    ...base,
    handlers,
    compute(event, state, previous) {
      state.scene.updateMatrixWorld();
      state.camera.updateMatrixWorld();
      compute(event, state, previous);
    },
  };
}

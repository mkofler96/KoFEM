// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import { addTail, flushSync, useThree } from "@react-three/fiber";
import { Vector3 } from "three";

export interface ViewportHooks {
  // Where a model-space point lands on the page (client pixels), so an E2E test
  // can click a known face the way a user does instead of writing the pick
  // into the store. Null when the point is behind the camera.
  project(point: [number, number, number]): { x: number; y: number } | null;
  // Turn the camera to look at the orbit target from `direction`, keeping its
  // distance — what clicking an axis of the view gizmo does.
  lookFrom(direction: [number, number, number]): void;
  // Resolves once the viewport shows the store as it is now: the scene's React
  // tree has applied every pending change (Fit View moves the camera in one of
  // its effects), that state has been drawn, and nothing asks for another
  // frame. The test fixtures await it before they project a point or click, so
  // no test depends on how long the viewport takes to catch up.
  settled(): Promise<void>;
}

// Exposes the viewport camera to Playwright as window.__kofemViewport, beside
// the store (__kofemStore) and the worker (__kofem) already exposed.
export function ViewportTestHooks() {
  const { camera, controls, gl, invalidate } = useThree();

  useEffect(() => {
    const hooks: ViewportHooks = {
      project(point) {
        // The canvas renders on demand, so the camera matrices may not have
        // caught up with a move made since the last frame (e.g. lookFrom).
        // Project with an up-to-date copy: updating the live camera here
        // would hide a pick that raycasts with stale matrices.
        const view = camera.clone();
        view.updateMatrixWorld();
        const ndc = new Vector3(...point).project(view);
        if (ndc.z > 1) return null;
        const rect = gl.domElement.getBoundingClientRect();
        return {
          x: rect.left + ((ndc.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - ndc.y) / 2) * rect.height,
        };
      },
      lookFrom(direction) {
        const orbit = controls as unknown as {
          target: Vector3;
          update(): void;
        } | null;
        if (!orbit)
          throw new Error("lookFrom: the orbit controls are not mounted yet");
        const distance = camera.position.distanceTo(orbit.target);
        camera.position
          .copy(orbit.target)
          .addScaledVector(new Vector3(...direction).normalize(), distance);
        orbit.update();
        invalidate();
      },
      settled() {
        // The scene's tree applies a store change in a scheduled task (see
        // pickingEvents); apply it now, effects included.
        flushSync(() => {});
        // R3F runs its tail callbacks when a frame finds nothing left to
        // draw and the render loop stops. Asking for one frame first makes
        // sure the loop runs and the tail comes.
        return new Promise<void>((resolve) => {
          const unsubscribe = addTail(() => {
            unsubscribe();
            resolve();
          });
          invalidate();
        });
      },
    };
    const host = window as Window & { __kofemViewport?: ViewportHooks };
    host.__kofemViewport = hooks;
    // An unmounted canvas draws no frame, so its settled() would never
    // resolve. Without hooks a test waits for the next mount instead.
    return () => {
      if (host.__kofemViewport === hooks) delete host.__kofemViewport;
    };
  }, [camera, controls, gl, invalidate]);

  return null;
}

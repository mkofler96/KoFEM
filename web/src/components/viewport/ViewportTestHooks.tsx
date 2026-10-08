// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";

export interface ViewportHooks {
  // Where a model-space point lands on the page (client pixels), so an E2E test
  // can click a known face the way a user does instead of writing the pick
  // into the store. Null when the point is behind the camera.
  project(point: [number, number, number]): { x: number; y: number } | null;
  // Turn the camera to look at the orbit target from `direction`, keeping its
  // distance — what clicking an axis of the view gizmo does.
  lookFrom(direction: [number, number, number]): void;
}

// Exposes the viewport camera to Playwright as window.__kofemViewport, beside
// the store (__kofemStore) and the worker (__kofem) already exposed.
export function ViewportTestHooks() {
  const { camera, controls, gl } = useThree();

  useEffect(() => {
    const hooks: ViewportHooks = {
      project(point) {
        const ndc = new THREE.Vector3(...point).project(camera);
        if (ndc.z > 1) return null;
        const rect = gl.domElement.getBoundingClientRect();
        return {
          x: rect.left + ((ndc.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - ndc.y) / 2) * rect.height,
        };
      },
      lookFrom(direction) {
        const orbit = controls as unknown as {
          target: THREE.Vector3;
          update(): void;
        } | null;
        if (!orbit)
          throw new Error("lookFrom: the orbit controls are not mounted yet");
        const distance = camera.position.distanceTo(orbit.target);
        camera.position
          .copy(orbit.target)
          .addScaledVector(
            new THREE.Vector3(...direction).normalize(),
            distance,
          );
        orbit.update();
      },
    };
    (window as Window & { __kofemViewport?: ViewportHooks }).__kofemViewport =
      hooks;
  }, [camera, controls, gl]);

  return null;
}

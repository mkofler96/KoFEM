// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { Mesh, Vector3, type BufferGeometry } from "three";
import { viewSettled } from "./viewSettled";

export interface ViewCamera {
  type: "PerspectiveCamera" | "OrthographicCamera";
  // The unit vector the camera looks along.
  direction: [number, number, number];
  // The orbit target.
  target: [number, number, number];
}

export interface ViewportHooks {
  // Where a model-space point lands on the page (client pixels), so an E2E test
  // can click a known face the way a user does instead of writing the pick
  // into the store. Null when the point is behind the camera.
  project(point: [number, number, number]): { x: number; y: number } | null;
  // Turn the camera to look at the orbit target from `direction`, keeping its
  // distance — what clicking an axis of the view gizmo does.
  lookFrom(direction: [number, number, number]): void;
  // The camera's kind (projection), where it looks and what at.
  camera(): ViewCamera;
  // Resolves once the viewport shows the store as it is now: the scene's React
  // tree has applied every pending change (Fit View moves the camera in one of
  // its effects), that state has been drawn, and nothing asks for another
  // frame. The test fixtures await it before they project a point or click, so
  // no test depends on how long the viewport takes to catch up.
  settled(): Promise<void>;
  // How many line segments the visible objects named `name` draw, read from
  // their `userData.segments` — an edge highlight's polyline (EdgeOverlay).
  drawnSegments(name: string): number;
  // The vertex positions (x, y, z, …) of the visible meshes named `name`, in
  // model space — where the result surface is drawn (ResultsColormap).
  drawnPositions(name: string): number[];
}

// Exposes the viewport camera to Playwright as window.__kofemViewport, beside
// the store (__kofemStore) and the worker (__kofem) already exposed.
export function ViewportTestHooks() {
  const { camera, controls, gl, invalidate, get, scene } = useThree();

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
      camera() {
        const orbit = controls as unknown as { target: Vector3 } | null;
        if (!orbit)
          throw new Error("camera: the orbit controls are not mounted yet");
        if (
          camera.type !== "PerspectiveCamera" &&
          camera.type !== "OrthographicCamera"
        )
          throw new Error(`camera: unexpected camera ${camera.type}`);
        // An up-to-date copy, as in project().
        const view = camera.clone();
        view.updateMatrixWorld();
        const direction = view.getWorldDirection(new Vector3());
        return {
          type: camera.type,
          direction: [direction.x, direction.y, direction.z],
          target: [orbit.target.x, orbit.target.y, orbit.target.z],
        };
      },
      settled() {
        // settled() draws nothing itself: a test may call it hundreds of
        // times.
        return viewSettled(get);
      },
      drawnSegments(name) {
        let total = 0;
        scene.traverseVisible((object) => {
          if (object.name !== name) return;
          const segments: unknown = object.userData.segments;
          if (typeof segments !== "number")
            throw new Error(`drawnSegments: ${name} has no segment count`);
          total += segments;
        });
        return total;
      },
      drawnPositions(name) {
        const out: number[] = [];
        let found = false;
        scene.traverseVisible((object) => {
          if (object.name !== name || !(object instanceof Mesh)) return;
          found = true;
          object.updateMatrixWorld();
          const position = (object.geometry as BufferGeometry).getAttribute(
            "position",
          );
          const vertex = new Vector3();
          for (let i = 0; i < position.count; i++) {
            vertex
              .fromBufferAttribute(position, i)
              .applyMatrix4(object.matrixWorld);
            out.push(vertex.x, vertex.y, vertex.z);
          }
        });
        if (!found) throw new Error(`drawnPositions: no visible mesh ${name}`);
        return out;
      },
    };
    const host = window as Window & { __kofemViewport?: ViewportHooks };
    host.__kofemViewport = hooks;
    // An unmounted canvas draws no frame, so its settled() would never
    // resolve. Without hooks a test waits for the next mount instead.
    return () => {
      if (host.__kofemViewport === hooks) delete host.__kofemViewport;
    };
  }, [camera, controls, gl, invalidate, get, scene]);

  return null;
}

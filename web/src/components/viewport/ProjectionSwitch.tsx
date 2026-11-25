// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useModelStore } from "../../store/modelStore";
import {
  projectionOf,
  switchProjection,
  type ProjectionCamera,
} from "../../lib/projection";

// Puts the viewport camera in the store's projection (KOF-429), keeping the
// view (lib/projection).
//
// The new camera becomes the canvas's default camera. drei's OrbitControls
// build new controls for it, aimed at the origin, so the old target is kept
// here until those controls have mounted and is handed to them then.
export function ProjectionSwitch() {
  const projection = useModelStore((s) => s.projection);
  const camera = useThree((s) => s.camera) as ProjectionCamera;
  const controls = useThree(
    (s) => s.controls,
  ) as unknown as OrbitControlsImpl | null;
  const set = useThree((s) => s.set);
  const get = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);
  const pendingTarget = useRef<Vector3 | null>(null);

  useEffect(() => {
    if (projectionOf(camera) === projection) return;
    // Before the controls mount, the camera looks at the origin.
    const target = controls ? controls.target.clone() : new Vector3();
    pendingTarget.current = target;
    set({
      camera: switchProjection(camera, target, projection, get().size),
    });
  }, [projection, camera, controls, set, get]);

  useEffect(() => {
    const target = pendingTarget.current;
    if (!controls || !target || controls.object !== camera) return;
    pendingTarget.current = null;
    controls.target.copy(target);
    controls.update();
    invalidate();
  }, [camera, controls, invalidate]);

  return null;
}

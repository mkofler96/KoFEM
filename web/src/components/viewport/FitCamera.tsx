// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useThree, type RootState } from "@react-three/fiber";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useModelStore } from "../../store/modelStore";
import { boundingSphere, fitViewBox, nodeFrame } from "../../lib/fitView";
import { WORLD_UP } from "../../lib/orbitPivot";
import {
  fitDistance,
  placeCamera,
  type ProjectionCamera,
} from "../../lib/projection";

// [1,1,1] normalized — standard isometric direction
const ISO_DIR = new THREE.Vector3(1, 1, 1).normalize();

export interface DrawnResult {
  displacements: ArrayLike<number>;
  // The factor the scene multiplies the displacements by.
  scale: number;
}

// Put the camera on `direction` from `center`, at the distance where a sphere
// of `radius` fills the view, and orbit about `center`. The canvas renders on
// demand: a move that only changes near/far fires no controls change event,
// so it asks for the frame explicitly.
function frameSphere(
  orbit: OrbitControlsImpl,
  state: RootState,
  center: THREE.Vector3,
  direction: THREE.Vector3,
  radius: number,
): void {
  const { camera, size, invalidate } = state;
  placeCamera(
    camera as ProjectionCamera,
    center,
    direction,
    fitDistance(radius, size),
    size,
  );
  orbit.target.copy(center);
  orbit.update();
  invalidate();
}

// Fit view frames what the scene draws (KOF-385), so MeshScene mounts it and
// passes the deformed result as drawn: null when no result is shown deformed.
export function FitCamera({ result }: { result: DrawnResult | null }) {
  const { controls, get } = useThree();
  const orbit = controls as unknown as OrbitControlsImpl | null;
  const fitViewTrigger = useModelStore((s) => s.fitViewTrigger);
  const frameNodeTrigger = useModelStore((s) => s.frameNodeTrigger);
  // Read at fit time: a new result or scale does not refit by itself.
  const resultRef = useRef(result);
  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  // The trigger last fitted. Switching the projection (ProjectionSwitch)
  // mounts new controls; that keeps the view and must not fit it again.
  const fitted = useRef<number | null>(null);
  // The Show request last served. A request made before this camera mounted
  // was for the view it replaced, so it starts as served.
  const framed = useRef(useModelStore.getState().frameNodeTrigger);

  useEffect(() => {
    // Controls may not be registered yet on the initial mount — skip and wait
    // for the effect to re-fire once OrbitControls registers via makeDefault.
    if (!orbit || fitted.current === fitViewTrigger) return;

    const { nodes, stepSurface, showUndeformedOverlay } =
      useModelStore.getState();
    const drawn = resultRef.current;
    const box = fitViewBox({
      nodes,
      stepSurface,
      deformed: drawn && { ...drawn, showUndeformed: showUndeformedOverlay },
    });
    if (box === null) return;
    const { center, radius } = boundingSphere(box);
    const state = get();
    // Upright, also after a drag turned the view upside down.
    state.camera.up.copy(WORLD_UP);
    frameSphere(orbit, state, new THREE.Vector3(...center), ISO_DIR, radius);
    fitted.current = fitViewTrigger;
  }, [fitViewTrigger, orbit, get]); // deps intentionally omit scene state — refit only on trigger

  // Show keeps the direction the user looks from and moves in on the node.
  useEffect(() => {
    if (!orbit || framed.current === frameNodeTrigger) return;
    framed.current = frameNodeTrigger;
    const { nodes, stepSurface, showUndeformedOverlay, frameNodeId } =
      useModelStore.getState();
    const index = nodes.findIndex((n) => n.id === frameNodeId);
    if (index < 0)
      throw new Error(`Show: node ${frameNodeId} is not in the mesh`);
    const drawn = resultRef.current;
    const { center, radius } = nodeFrame(
      {
        nodes,
        stepSurface,
        deformed: drawn && { ...drawn, showUndeformed: showUndeformedOverlay },
      },
      index,
    );
    const state = get();
    const direction = state.camera.position
      .clone()
      .sub(orbit.target)
      .normalize();
    frameSphere(orbit, state, new THREE.Vector3(...center), direction, radius);
  }, [frameNodeTrigger, orbit, get]);

  return null;
}

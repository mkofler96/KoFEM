// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useModelStore } from "../../store/modelStore";
import { fitViewBox, nodeFrame } from "../../lib/fitView";
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

// Fit view frames what the scene draws (KOF-385), so MeshScene mounts it and
// passes the deformed result as drawn: null when no result is shown deformed.
// It also serves Results → Show (KOF-495), which frames one node as drawn.
export function FitCamera({ result }: { result: DrawnResult | null }) {
  const { controls, invalidate, get } = useThree();
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
    if (!controls || fitted.current === fitViewTrigger) return;

    const { nodes, stepSurface, showUndeformedOverlay } =
      useModelStore.getState();
    const drawn = resultRef.current;
    const box = fitViewBox({
      nodes,
      stepSurface,
      deformed: drawn && { ...drawn, showUndeformed: showUndeformedOverlay },
    });
    if (box === null) return;
    const [minX, minY, minZ] = box.min;
    const [maxX, maxY, maxZ] = box.max;

    const center = new THREE.Vector3(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2,
    );
    const diagonal = Math.sqrt(
      (maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2,
    );
    const radius = Math.max(diagonal / 2, 1e-6);

    const { camera, size } = get();
    // Upright, also after a drag turned the view upside down.
    camera.up.copy(WORLD_UP);
    placeCamera(
      camera as ProjectionCamera,
      center,
      ISO_DIR,
      fitDistance(radius, size),
      size,
    );
    fitted.current = fitViewTrigger;

    const oc = controls as unknown as { target: THREE.Vector3; update(): void };
    oc.target.copy(center);
    oc.update();
    // The canvas renders on demand: a fit that only changes near/far fires no
    // controls change event, so ask for the frame explicitly.
    invalidate();
  }, [fitViewTrigger, controls, invalidate, get]); // deps intentionally omit scene state — refit only on trigger

  // Show keeps the direction the user looks from and moves in on the node.
  useEffect(() => {
    if (!controls || framed.current === frameNodeTrigger) return;
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
    const target = new THREE.Vector3(...center);
    const { camera, size } = get();
    const oc = controls as unknown as { target: THREE.Vector3; update(): void };
    const direction = camera.position.clone().sub(oc.target).normalize();
    placeCamera(
      camera as ProjectionCamera,
      target,
      direction,
      fitDistance(radius, size),
      size,
    );
    oc.target.copy(target);
    oc.update();
    invalidate();
  }, [frameNodeTrigger, controls, invalidate, get]);

  return null;
}

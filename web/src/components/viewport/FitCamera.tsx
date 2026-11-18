// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useModelStore } from "../../store/modelStore";
import { fitViewBox } from "../../lib/fitView";

// [1,1,1] normalized — standard isometric direction
const ISO_DIR = new THREE.Vector3(1, 1, 1).normalize();

export interface DrawnResult {
  displacements: ArrayLike<number>;
  // The factor the scene multiplies the displacements by.
  scale: number;
}

// Fit view frames what the scene draws (KOF-385), so MeshScene mounts it and
// passes the deformed result as drawn: null when no result is shown deformed.
export function FitCamera({ result }: { result: DrawnResult | null }) {
  const { camera, controls, invalidate } = useThree();
  const fitViewTrigger = useModelStore((s) => s.fitViewTrigger);
  // Read at fit time: a new result or scale does not refit by itself.
  const resultRef = useRef(result);
  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  useEffect(() => {
    // Controls may not be registered yet on the initial mount — skip and wait
    // for the effect to re-fire once OrbitControls registers via makeDefault.
    if (!controls) return;

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

    // Fit the narrower of the two angles of view: the horizontal one on a
    // phone held upright.
    const cam = camera as THREE.PerspectiveCamera;
    const halfTan = Math.tan((cam.fov * Math.PI) / 360);
    const distance = radius / (halfTan * Math.min(1, cam.aspect));

    camera.position.copy(center).addScaledVector(ISO_DIR, distance);
    cam.near = Math.max(distance * 0.001, 1e-4);
    cam.far = distance * 100;
    cam.updateProjectionMatrix();

    const oc = controls as unknown as { target: THREE.Vector3; update(): void };
    oc.target.copy(center);
    oc.update();
    // The canvas renders on demand: a fit that only changes near/far fires no
    // controls change event, so ask for the frame explicitly.
    invalidate();
  }, [fitViewTrigger, controls, invalidate]); // deps intentionally omit scene state — refit only on trigger

  return null;
}

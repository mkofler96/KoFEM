// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { orbitAboutPivot, orbitAngles } from "../../lib/orbitPivot";

// Turns the view about the model point under the cursor (KOF-345). The orbit
// controls keep panning and zooming; their own rotation is switched off
// (enableRotate={false} in Viewport), and this component turns the view
// instead: on a one-pointer drag with the primary button, about the surface
// point the drag started on, or about the orbit target when it started on
// the background.
export function OrbitPivot() {
  const { camera, controls, gl, scene, invalidate } = useThree();

  useEffect(() => {
    // makeDefault registers the controls after the first render.
    if (!controls) return;
    const orbit = controls as unknown as OrbitControlsImpl;
    const element = gl.domElement;
    const raycaster = new THREE.Raycaster();
    const pointers = new Set<number>();
    let drag: {
      pointerId: number;
      x: number;
      y: number;
      pivot: THREE.Vector3;
    } | null = null;

    // The nearest opaque surface under the pointer. Overlays that write no
    // depth (the translucent split plane, highlights) are not surfaces to
    // turn about.
    function surfacePoint(event: PointerEvent): THREE.Vector3 | null {
      const rect = element.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      // The canvas renders on demand: matrices may lag the last move.
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      raycaster.setFromCamera(ndc, camera);
      for (const hit of raycaster.intersectObject(scene, true)) {
        if (isOpaqueVisibleMesh(hit.object)) return hit.point.clone();
      }
      return null;
    }

    function onPointerDown(event: PointerEvent) {
      pointers.add(event.pointerId);
      // A second finger is a pinch or a pan: the orbit controls take it.
      if (pointers.size > 1) {
        drag = null;
        return;
      }
      if (!orbit.enabled || event.button !== 0) return;
      // Ctrl, Meta or Shift with the left button pans (OrbitControls).
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        pivot: surfacePoint(event) ?? orbit.target.clone(),
      };
    }

    function onPointerMove(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const { azimuth, polar } = orbitAngles(
        (event.clientX - drag.x) * orbit.rotateSpeed,
        (event.clientY - drag.y) * orbit.rotateSpeed,
        element.clientHeight,
      );
      drag.x = event.clientX;
      drag.y = event.clientY;
      orbitAboutPivot(
        camera,
        orbit.target,
        drag.pivot,
        camera.up,
        azimuth,
        polar,
      );
      orbit.update();
      invalidate();
    }

    function onPointerUp(event: PointerEvent) {
      pointers.delete(event.pointerId);
      if (drag?.pointerId === event.pointerId) drag = null;
    }

    // Capture phase: runs before the orbit controls' own handlers on the same
    // element, so the pivot is chosen from the view the user pressed on.
    element.addEventListener("pointerdown", onPointerDown, true);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", onPointerUp);
    element.addEventListener("pointercancel", onPointerUp);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown, true);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerUp);
    };
  }, [camera, controls, gl, scene, invalidate]);

  return null;
}

function isOpaqueVisibleMesh(object: THREE.Object3D): boolean {
  if (!(object instanceof THREE.Mesh)) return false;
  for (let o: THREE.Object3D | null = object; o; o = o.parent)
    if (!o.visible) return false;
  const materials: THREE.Material[] = Array.isArray(object.material)
    ? object.material
    : [object.material];
  return materials.some((m) => m.visible && m.depthWrite);
}

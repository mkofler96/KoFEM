// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Draws the analysis report's figures (KOF-391, lib/report/figures): the
// settled view as it is, then the whole model from the isometric direction,
// each read off the canvas right after drawing it. The camera is put back
// before anything else draws, so the user's view does not move.

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { Box3, MathUtils, PerspectiveCamera, Sphere, Vector3 } from "three";
import { registerFigureCapture } from "../../lib/report/figures";
import { viewSettled } from "./viewSettled";

const ISOMETRIC = new Vector3(1, 1, 1).normalize();

export function ReportCapture() {
  const { camera, controls, gl, scene, get, invalidate } = useThree();
  useEffect(
    () =>
      registerFigureCapture(async () => {
        const orbit = controls as unknown as {
          target: Vector3;
          update(): void;
        } | null;
        if (!orbit)
          throw new Error("report figures: the orbit controls are not mounted");
        await viewSettled(get);
        const draw = () => {
          camera.updateMatrixWorld();
          gl.render(scene, camera);
          return gl.domElement.toDataURL("image/png");
        };
        const current = draw();
        const saved = camera.position.clone();
        // The whole model, from far enough that its bounding sphere fills the
        // perspective view; an orthographic view keeps its zoom.
        const sphere = new Box3()
          .setFromObject(scene)
          .getBoundingSphere(new Sphere());
        const distance =
          camera instanceof PerspectiveCamera
            ? (1.1 * sphere.radius) /
              Math.sin(MathUtils.degToRad(camera.fov) / 2)
            : saved.distanceTo(orbit.target);
        camera.position
          .copy(sphere.center)
          .addScaledVector(ISOMETRIC, distance);
        camera.lookAt(sphere.center);
        const isometric = draw();
        camera.position.copy(saved);
        orbit.update();
        invalidate();
        return { current, isometric };
      }),
    [camera, controls, gl, scene, get, invalidate],
  );
  return null;
}

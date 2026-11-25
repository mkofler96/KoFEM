// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Draws the analysis report's figures (KOF-391, lib/report/figures): the
// settled view as it is, then the whole model from the isometric direction,
// each read off the canvas right after drawing it. The isometric figure is
// drawn with a copy of the camera, placed as Fit View places it, so the
// user's view does not move.

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { Box3, Sphere, Vector3, type Camera } from "three";
import { registerFigureCapture } from "../../lib/report/figures";
import { WORLD_UP } from "../../lib/orbitPivot";
import {
  fitDistance,
  placeCamera,
  type ProjectionCamera,
} from "../../lib/projection";
import { viewSettled } from "./viewSettled";

const ISOMETRIC = new Vector3(1, 1, 1).normalize();

export function ReportCapture() {
  const { camera, gl, scene, get } = useThree();
  useEffect(
    () =>
      registerFigureCapture(async () => {
        await viewSettled(get);
        const draw = (view: Camera) => {
          view.updateMatrixWorld();
          gl.render(scene, view);
          return gl.domElement.toDataURL("image/png");
        };
        const current = draw(camera);
        const sphere = new Box3()
          .setFromObject(scene)
          .getBoundingSphere(new Sphere());
        const { size } = get();
        const isometric = camera.clone() as ProjectionCamera;
        isometric.up.copy(WORLD_UP);
        placeCamera(
          isometric,
          sphere.center,
          ISOMETRIC,
          fitDistance(Math.max(sphere.radius, 1e-6), size),
          size,
        );
        const figures = { current, isometric: draw(isometric) };
        // The canvas now shows the isometric figure: draw the view again.
        draw(camera);
        return figures;
      }),
    [camera, gl, scene, get],
  );
  return null;
}

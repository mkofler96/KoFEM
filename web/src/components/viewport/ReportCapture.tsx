// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Draws the analysis report's figures (KOF-391, lib/report/figures): the
// settled view as it is, then, when asked, the whole model from the
// isometric direction, each read off the canvas right after drawing it and
// cropped to what was drawn. The isometric figure is drawn with a copy of the
// camera, placed as Fit View places it, so the user's view does not move.

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { Box3, Sphere, Vector3, type Camera } from "three";
import {
  registerFigureCapture,
  type FigureImage,
} from "../../lib/report/figures";
import { WORLD_UP } from "../../lib/orbitPivot";
import {
  fitDistance,
  placeCamera,
  type ProjectionCamera,
} from "../../lib/projection";
import { viewSettled } from "./viewSettled";
import { tr } from "../../i18n/useLocale";
import { reportMessages } from "../../i18n/messages/report";

const ISOMETRIC = new Vector3(1, 1, 1).normalize();
// Margin kept around the drawn pixels, in canvas pixels.
const PAD = 12;

// The canvas cropped to the box of its drawn (non-transparent) pixels.
function cropped(canvas: HTMLCanvasElement): FigureImage {
  const { width, height } = canvas;
  const copy = document.createElement("canvas");
  copy.width = width;
  copy.height = height;
  const context = copy.getContext("2d");
  if (context === null) throw new Error(tr(reportMessages).noViewport);
  context.drawImage(canvas, 0, 0);
  const alpha = context.getImageData(0, 0, width, height).data;
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (alpha[(y * width + x) * 4 + 3] > 0) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) throw new Error(tr(reportMessages).emptyFigure);
  x0 = Math.max(0, x0 - PAD);
  y0 = Math.max(0, y0 - PAD);
  const cropWidth = Math.min(width, x1 + PAD + 1) - x0;
  const cropHeight = Math.min(height, y1 + PAD + 1) - y0;
  const out = document.createElement("canvas");
  out.width = cropWidth;
  out.height = cropHeight;
  const outContext = out.getContext("2d");
  if (outContext === null) throw new Error(tr(reportMessages).noViewport);
  outContext.drawImage(
    copy,
    x0,
    y0,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight,
  );
  return {
    src: out.toDataURL("image/png"),
    width: cropWidth,
    height: cropHeight,
  };
}

export function ReportCapture() {
  const { camera, gl, scene, get } = useThree();
  useEffect(
    () =>
      registerFigureCapture(async (withIsometric) => {
        await viewSettled(get);
        const draw = (view: Camera) => {
          view.updateMatrixWorld();
          gl.render(scene, view);
          return cropped(gl.domElement);
        };
        const current = draw(camera);
        if (!withIsometric) return { current, isometric: null };
        const sphere = new Box3()
          .setFromObject(scene)
          .getBoundingSphere(new Sphere());
        const { size } = get();
        const view = camera.clone() as ProjectionCamera;
        view.up.copy(WORLD_UP);
        placeCamera(
          view,
          sphere.center,
          ISOMETRIC,
          fitDistance(Math.max(sphere.radius, 1e-6), size),
          size,
        );
        const isometric = draw(view);
        // The canvas now shows the isometric figure: draw the view again.
        gl.render(scene, camera);
        return { current, isometric };
      }),
    [camera, gl, scene, get],
  );
  return null;
}

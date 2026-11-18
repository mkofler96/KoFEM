// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Rotating the view about a chosen point (KOF-345): the model point under the
// cursor when a drag starts, so the part turns about what the user looks at
// instead of about the orbit target, which may lie in empty space or wherever
// a pan left it.
//
// OrbitControls always looks at its target, so moving the target to the pivot
// would make the view jump. Instead the camera, its orientation and the target
// turn together as one rigid body about the pivot: nothing jumps, and the
// controls still look at their target afterwards, so panning, zooming and the
// view gizmo carry on from the new pose.

import { Quaternion, Vector3 } from "three";
import type { Camera } from "three";

// How close the view direction may come to straight up or down. OrbitControls
// keeps the same margin from the poles.
const POLE_MARGIN = 1e-6;

const offset = new Vector3();
const viewDir = new Vector3();
const right = new Vector3();
const turn = new Quaternion();
const tilt = new Quaternion();

/**
 * Turn `camera` and `target` about `pivot`: by `-azimuth` about the world `up`
 * axis and by `-polar` about the camera's right axis, the signs OrbitControls
 * uses for the same drag. The tilt stops short of the poles, so the view never
 * turns upside down. Mutates `camera` and `target`.
 */
export function orbitAboutPivot(
  camera: Camera,
  target: Vector3,
  pivot: Vector3,
  up: Vector3,
  azimuth: number,
  polar: number,
): void {
  // The polar angle of the view direction, from `up`. The tilt axis is
  // horizontal and perpendicular to the view, so the tilt changes this angle
  // by exactly -polar; clamp it there.
  viewDir.subVectors(camera.position, target);
  const distance = viewDir.length();
  if (distance === 0)
    throw new Error("orbitAboutPivot: the camera sits on its target");
  viewDir.divideScalar(distance);
  const phi = Math.acos(Math.min(1, Math.max(-1, viewDir.dot(up))));
  const tiltAngle =
    phi - Math.min(Math.PI - POLE_MARGIN, Math.max(POLE_MARGIN, phi - polar));

  right.crossVectors(up, viewDir);
  if (right.lengthSq() === 0)
    throw new Error("orbitAboutPivot: the camera looks straight along up");
  right.normalize();

  tilt.setFromAxisAngle(right, -tiltAngle);
  turn.setFromAxisAngle(up, -azimuth).multiply(tilt);

  offset.subVectors(camera.position, pivot).applyQuaternion(turn);
  camera.position.copy(pivot).add(offset);
  offset.subVectors(target, pivot).applyQuaternion(turn);
  target.copy(pivot).add(offset);
  camera.quaternion.premultiply(turn);
  camera.updateMatrixWorld();
}

/**
 * The turn for a drag of (dx, dy) pixels in a viewport `heightPx` tall: a
 * drag across the full height turns a full circle, as in OrbitControls.
 */
export function orbitAngles(
  dx: number,
  dy: number,
  heightPx: number,
): { azimuth: number; polar: number } {
  if (!(heightPx > 0))
    throw new Error(`orbitAngles: viewport height ${heightPx} px`);
  return {
    azimuth: (2 * Math.PI * dx) / heightPx,
    polar: (2 * Math.PI * dy) / heightPx,
  };
}

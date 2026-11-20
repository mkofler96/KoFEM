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

// The world's up direction: the view's vertical while it is upright.
// `camera.up` follows the view instead, and points down while it is upside
// down (see orbitAboutPivot).
export const WORLD_UP: Readonly<Vector3> = new Vector3(0, 1, 0);

const offset = new Vector3();
const right = new Vector3();
const screenUp = new Vector3();
const axis = new Vector3();
const turn = new Quaternion();
const tilt = new Quaternion();

/**
 * Turn `camera` and `target` about `pivot`: by `-polar` about the camera's
 * right axis, then by `-azimuth` about the vertical, the signs OrbitControls
 * uses for the same drag. `up` is the world's up direction. Mutates `camera`
 * and `target`.
 *
 * The tilt has no limit: it carries the view over the top or bottom and on
 * round, and the view turns upside down (KOF-420). OrbitControls look at their
 * target along `camera.up`, so `camera.up` is set to `up` while the view is
 * upright and to `-up` while it is upside down; otherwise their next update
 * would turn the view upright again. The sideways turn is about `camera.up`,
 * so a drag to the right turns the view the same way on screen either way.
 */
export function orbitAboutPivot(
  camera: Camera,
  target: Vector3,
  pivot: Vector3,
  up: Vector3,
  azimuth: number,
  polar: number,
): void {
  const side = Math.sign(camera.up.dot(up));
  if (side === 0) throw new Error("orbitAboutPivot: camera.up is horizontal");
  if (camera.position.equals(target))
    throw new Error("orbitAboutPivot: the camera sits on its target");

  right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  tilt.setFromAxisAngle(right, -polar);
  axis.copy(up).multiplyScalar(side);
  turn.setFromAxisAngle(axis, -azimuth).multiply(tilt);

  offset.subVectors(camera.position, pivot).applyQuaternion(turn);
  camera.position.copy(pivot).add(offset);
  offset.subVectors(target, pivot).applyQuaternion(turn);
  target.copy(pivot).add(offset);
  camera.quaternion.premultiply(turn);
  camera.updateMatrixWorld();

  // Exactly at the top or bottom view the screen's up is horizontal: keep
  // camera.up as it was.
  screenUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const upright = screenUp.dot(up);
  if (upright !== 0) camera.up.copy(up).multiplyScalar(Math.sign(upright));
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

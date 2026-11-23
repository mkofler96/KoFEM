// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Perspective and orthographic projection of the viewport (KOF-429).
//
// Both cameras are described by one number, the view distance: how far from
// the orbit target a perspective camera stands. An orthographic camera with
// view distance d shows, in the plane through the target, exactly what the
// perspective camera at d shows there, so switching keeps the view direction,
// the target and the apparent size of the model. Orbit controls zoom an
// orthographic camera by its zoom, not by moving it, so it stands well back
// of the target instead: the raycaster casts picking rays from the camera's
// own plane, and a model part behind that plane could be neither drawn nor
// picked.

import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import type { Camera } from "three";

export type Projection = "perspective" | "orthographic";

export type ProjectionCamera = PerspectiveCamera | OrthographicCamera;

// Vertical angle of view of the perspective camera, in degrees.
export const VIEW_FOV = 45;

// How far the far plane lies, in view distances: room for the model and for
// zooming out.
const FAR_FACTOR = 100;

export interface ViewSize {
  width: number;
  height: number;
}

export function projectionOf(camera: Camera): Projection {
  if (camera instanceof PerspectiveCamera) return "perspective";
  if (camera instanceof OrthographicCamera) return "orthographic";
  throw new Error(`projectionOf: unsupported camera ${camera.type}`);
}

function halfTan(): number {
  return Math.tan((VIEW_FOV * Math.PI) / 360);
}

/**
 * The view distance of `camera` looking at `target`: its distance for a
 * perspective camera; for an orthographic one, the distance at which the
 * perspective camera shows the same height in the target's plane.
 */
export function viewDistance(
  camera: ProjectionCamera,
  target: Vector3,
): number {
  if (camera instanceof PerspectiveCamera)
    return camera.position.distanceTo(target);
  const height = (camera.top - camera.bottom) / camera.zoom;
  return height / (2 * halfTan());
}

/**
 * The view distance at which a sphere of `radius` fills the narrower side of
 * a viewport of `size` pixels: the horizontal one on a phone held upright.
 */
export function fitDistance(radius: number, size: ViewSize): number {
  return radius / (halfTan() * Math.min(1, size.width / size.height));
}

/**
 * Put `camera` on the line from `target` along `direction` (a unit vector,
 * pointing from the target to the camera), looking at the target with view
 * distance `distance`, and set its frustum for a viewport of `size` pixels.
 * The camera's `up` decides the roll.
 */
export function placeCamera(
  camera: ProjectionCamera,
  target: Vector3,
  direction: Vector3,
  distance: number,
  size: ViewSize,
): void {
  if (!(distance > 0))
    throw new Error(`placeCamera: view distance ${distance}`);
  if (!(size.width > 0 && size.height > 0))
    throw new Error(`placeCamera: viewport ${size.width}×${size.height} px`);
  const far = distance * FAR_FACTOR;
  if (camera instanceof PerspectiveCamera) {
    camera.fov = VIEW_FOV;
    camera.aspect = size.width / size.height;
    camera.near = Math.max(distance * 0.001, 1e-4);
    camera.far = far;
    camera.position.copy(target).addScaledVector(direction, distance);
  } else {
    // The frustum in pixels, as react-three-fiber sizes it on a resize; the
    // zoom scales it to the view height.
    camera.left = -size.width / 2;
    camera.right = size.width / 2;
    camera.top = size.height / 2;
    camera.bottom = -size.height / 2;
    camera.zoom = size.height / (2 * distance * halfTan());
    camera.near = 0;
    camera.far = far;
    camera.position.copy(target).addScaledVector(direction, far / 2);
  }
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

/**
 * A new camera in `projection` showing what `camera`, looking at `target`,
 * shows: the same direction, roll, target and apparent size in the target's
 * plane. Refuses a camera that is already in `projection`.
 */
export function switchProjection(
  camera: ProjectionCamera,
  target: Vector3,
  projection: Projection,
  size: ViewSize,
): ProjectionCamera {
  if (projectionOf(camera) === projection)
    throw new Error(`switchProjection: the camera is already ${projection}`);
  const direction = camera.position.clone().sub(target);
  if (direction.lengthSq() === 0)
    throw new Error("switchProjection: the camera sits on its target");
  direction.normalize();
  const next: ProjectionCamera =
    projection === "perspective"
      ? new PerspectiveCamera()
      : new OrthographicCamera();
  next.up.copy(camera.up);
  placeCamera(next, target, direction, viewDistance(camera, target), size);
  return next;
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Rotating the view turns the camera about the model point under the cursor
// (KOF-345). The camera, its orientation and the orbit target turn together as
// one rigid body, so the view does not jump when the drag starts and the orbit
// controls still look at their target afterwards.

import { expect, test } from "bun:test";
import { PerspectiveCamera, Spherical, Vector3 } from "three";
import { orbitAboutPivot, orbitAngles } from "../../src/lib/orbitPivot";

const UP = new Vector3(0, 1, 0);

// A camera on the iso diagonal looking at `target`, as Fit View leaves it.
function isoCamera(target: Vector3): PerspectiveCamera {
  const camera = new PerspectiveCamera(45, 1.5, 0.1, 1000);
  camera.position.copy(target).add(new Vector3(30, 30, 30));
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return camera;
}

// Where `point` sits in the camera's own frame: unchanged means it stays put
// on screen.
function inView(camera: PerspectiveCamera, point: Vector3): Vector3 {
  camera.updateMatrixWorld();
  return point.clone().applyMatrix4(camera.matrixWorldInverse);
}

function expectClose(a: Vector3, b: Vector3, digits = 9) {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
}

test("the pivot stays where it is on screen", () => {
  const target = new Vector3(5, 0, -3);
  const camera = isoCamera(target);
  const pivot = new Vector3(12, -4, 2);
  const before = inView(camera, pivot);

  orbitAboutPivot(camera, target, pivot, UP, 0.7, 0.3);

  expectClose(inView(camera, pivot), before);
});

test("the target turns with the camera, so the camera still looks at it", () => {
  const target = new Vector3(5, 0, -3);
  const camera = isoCamera(target);
  const distance = camera.position.distanceTo(target);

  orbitAboutPivot(camera, target, new Vector3(12, -4, 2), UP, -1.1, 0.4);

  expect(camera.position.distanceTo(target)).toBeCloseTo(distance, 9);
  const forward = camera.getWorldDirection(new Vector3());
  const toTarget = target.clone().sub(camera.position).normalize();
  expect(forward.dot(toTarget)).toBeCloseTo(1, 9);
  // The horizon stays level: the camera's right axis has no vertical part.
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  expect(right.y).toBeCloseTo(0, 9);
});

test("about the target it turns as the orbit controls do", () => {
  // OrbitControls: a drag changes the azimuth by -azimuth and the polar
  // angle by -polar, about the target, at a fixed distance.
  const target = new Vector3(1, 2, 3);
  const camera = isoCamera(target);
  const before = new Spherical().setFromVector3(
    camera.position.clone().sub(target),
  );

  orbitAboutPivot(camera, target, target.clone(), UP, 0.5, 0.2);

  const after = new Spherical().setFromVector3(
    camera.position.clone().sub(target),
  );
  expectClose(target, new Vector3(1, 2, 3));
  expect(after.radius).toBeCloseTo(before.radius, 9);
  expect(after.theta).toBeCloseTo(before.theta - 0.5, 9);
  expect(after.phi).toBeCloseTo(before.phi - 0.2, 9);
});

test("it stops at the pole instead of turning the view upside down", () => {
  const target = new Vector3(0, 0, 0);
  const camera = isoCamera(target);
  const pivot = new Vector3(4, 1, -2);
  const before = inView(camera, pivot);

  orbitAboutPivot(camera, target, pivot, UP, 0, 10);

  const view = new Spherical().setFromVector3(
    camera.position.clone().sub(target),
  );
  expect(view.phi).toBeGreaterThan(0);
  expect(view.phi).toBeLessThan(1e-3);
  const cameraUp = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  expect(cameraUp.dot(UP)).toBeGreaterThanOrEqual(0);
  // Clamped or not, the turn is still about the pivot.
  expectClose(inView(camera, pivot), before);
});

test("a drag across the full viewport height turns a full circle", () => {
  expect(orbitAngles(400, -200, 400)).toEqual({
    azimuth: 2 * Math.PI,
    polar: -Math.PI,
  });
});

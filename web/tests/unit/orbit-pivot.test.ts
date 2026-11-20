// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Rotating the view turns the camera about the model point under the cursor
// (KOF-345). The camera, its orientation and the orbit target turn together as
// one rigid body, so the view does not jump when the drag starts and the orbit
// controls still look at their target afterwards.

import { expect, test } from "bun:test";
import { PerspectiveCamera, Spherical, Vector3 } from "three";
import { OrbitControls } from "three-stdlib";
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

// A camera on the +z axis looking at `target`, upright, or upside down with
// `up` pointing down, as a turn over the top leaves it.
function sideCamera(target: Vector3, upsideDown = false): PerspectiveCamera {
  const camera = new PerspectiveCamera(45, 1.5, 0.1, 1000);
  camera.up.copy(UP).multiplyScalar(upsideDown ? -1 : 1);
  camera.position.copy(target).add(new Vector3(0, 0, 30));
  camera.lookAt(target);
  camera.updateMatrixWorld();
  return camera;
}

// The pose the camera shows: where it is and which way it faces.
function pose(camera: PerspectiveCamera) {
  return {
    position: camera.position.clone(),
    forward: camera.getWorldDirection(new Vector3()),
    up: new Vector3(0, 1, 0).applyQuaternion(camera.quaternion),
  };
}

function expectSamePose(
  a: ReturnType<typeof pose>,
  b: ReturnType<typeof pose>,
  digits = 9,
) {
  expectClose(a.position, b.position, digits);
  expectClose(a.forward, b.forward, digits);
  expectClose(a.up, b.up, digits);
}

// KOF-420: the full rotation of KOF-404 holds up and down too: a tilt past
// the top or bottom view carries on, and the view turns upside down.
test("a tilt carries the view over the top", () => {
  const target = new Vector3(0, 0, 0);
  const camera = sideCamera(target);
  const pivot = new Vector3(4, 1, -2);
  const before = inView(camera, pivot);

  // Half a turn: from the front, over the top, to the back.
  orbitAboutPivot(camera, target, pivot, UP, 0, Math.PI);

  const toCamera = camera.position.clone().sub(target).normalize();
  expectClose(toCamera, new Vector3(0, 0, -1));
  const screenUp = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  expectClose(screenUp, new Vector3(0, -1, 0));
  // The orbit controls look at their target along `camera.up`: it points
  // down now, or their next update would turn the view upright again.
  expectClose(camera.up, new Vector3(0, -1, 0));
  expectClose(inView(camera, pivot), before);
});

test("the orbit controls keep a view turned past the top", () => {
  const camera = sideCamera(new Vector3(0, 0, 0));
  const controls = new OrbitControls(camera);

  orbitAboutPivot(
    camera,
    controls.target,
    new Vector3(4, 1, -2),
    UP,
    0.3,
    0.75 * Math.PI,
  );
  const turned = pose(camera);
  controls.update();

  expectSamePose(pose(camera), turned);
});

test("a full turn up or down comes back to the start", () => {
  const target = new Vector3(5, 0, -3);
  const camera = isoCamera(target);
  const start = pose(camera);

  orbitAboutPivot(camera, target, new Vector3(12, -4, 2), UP, 0, 2 * Math.PI);

  expectSamePose(pose(camera), start);
  expectClose(camera.up, UP);
});

test("upside down, a sideways drag turns the view the same way on screen", () => {
  // A point between the camera and the target, at the centre of both views:
  // a sideways turn moves it across the screen.
  const target = new Vector3(0, 0, 0);
  const point = new Vector3(0, 0, 10);
  const upright = sideCamera(target);
  const upsideDown = sideCamera(target, true);
  const uprightBefore = inView(upright, point);
  const upsideDownBefore = inView(upsideDown, point);

  orbitAboutPivot(upright, target.clone(), target.clone(), UP, 0.2, 0);
  orbitAboutPivot(upsideDown, target.clone(), target.clone(), UP, 0.2, 0);

  const uprightMove = inView(upright, point).x - uprightBefore.x;
  const upsideDownMove = inView(upsideDown, point).x - upsideDownBefore.x;
  expect(Math.abs(uprightMove)).toBeGreaterThan(0.1);
  expect(upsideDownMove).toBeCloseTo(uprightMove, 9);
});

test("a drag across the full viewport height turns a full circle", () => {
  expect(orbitAngles(400, -200, 400)).toEqual({
    azimuth: 2 * Math.PI,
    polar: -Math.PI,
  });
});

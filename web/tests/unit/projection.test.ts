// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Switching the viewport between perspective and orthographic projection
// (KOF-429) keeps the view: the direction the camera looks from, the point it
// looks at, and how large the model appears in the plane through that point.

import { expect, test } from "bun:test";
import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import {
  VIEW_FOV,
  fitDistance,
  placeCamera,
  projectionOf,
  switchProjection,
  viewDistance,
  type ProjectionCamera,
} from "../../src/lib/projection";

const SIZE = { width: 800, height: 600 };
const UP = new Vector3(0, 1, 0);

// A perspective camera looking at `target` from `direction`, `distance` away.
function perspective(target: Vector3, direction: Vector3, distance: number) {
  const camera = new PerspectiveCamera(
    VIEW_FOV,
    SIZE.width / SIZE.height,
    0.1,
    distance * 100,
  );
  camera.up.copy(UP);
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

// Where `point` lands on screen, in normalized device coordinates.
function onScreen(camera: ProjectionCamera, point: Vector3): Vector3 {
  camera.updateMatrixWorld();
  return point.clone().project(camera);
}

function expectClose(a: Vector3, b: Vector3, digits = 9) {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
}

function looking(camera: ProjectionCamera): Vector3 {
  return camera.getWorldDirection(new Vector3());
}

// Points in the plane through the target, square to the view: the plane in
// which the switch keeps the apparent size.
function inTargetPlane(camera: ProjectionCamera, target: Vector3): Vector3[] {
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  return [
    target.clone().addScaledVector(right, 3),
    target.clone().addScaledVector(up, -2),
    target.clone().addScaledVector(right, -1.5).addScaledVector(up, 1),
  ];
}

const target = new Vector3(5, -2, 1);
const direction = new Vector3(1, 2, 3).normalize();

test("to orthographic: an orthographic camera looking the same way at the same point", () => {
  const from = perspective(target, direction, 20);

  const to = switchProjection(from, target, "orthographic", SIZE);

  expect(to).toBeInstanceOf(OrthographicCamera);
  expect(projectionOf(to)).toBe("orthographic");
  expectClose(looking(to), looking(from));
  expectClose(to.up, from.up);
  const toTarget = target.clone().sub(to.position).normalize();
  expectClose(toTarget, looking(from));
});

test("to orthographic: the model keeps its size on screen in the target's plane", () => {
  const from = perspective(target, direction, 20);
  const points = [target, ...inTargetPlane(from, target)];
  const before = points.map((p) => onScreen(from, p));

  const to = switchProjection(from, target, "orthographic", SIZE);

  points.forEach((p, i) => {
    const after = onScreen(to, p);
    expect(after.x).toBeCloseTo(before[i].x, 9);
    expect(after.y).toBeCloseTo(before[i].y, 9);
  });
});

test("to perspective: the model keeps its size on screen in the target's plane", () => {
  const ortho = switchProjection(
    perspective(target, direction, 20),
    target,
    "orthographic",
    SIZE,
  );
  // Zoomed in, as the wheel does in orthographic projection.
  ortho.zoom *= 2.5;
  ortho.updateProjectionMatrix();
  const points = [target, ...inTargetPlane(ortho, target)];
  const before = points.map((p) => onScreen(ortho, p));

  const to = switchProjection(ortho, target, "perspective", SIZE);

  expect(to).toBeInstanceOf(PerspectiveCamera);
  expect(projectionOf(to)).toBe("perspective");
  expectClose(looking(to), looking(ortho));
  points.forEach((p, i) => {
    const after = onScreen(to, p);
    expect(after.x).toBeCloseTo(before[i].x, 9);
    expect(after.y).toBeCloseTo(before[i].y, 9);
  });
  expect(to.position.distanceTo(target)).toBeCloseTo(20 / 2.5, 9);
});

test("there and back restores the perspective camera", () => {
  const from = perspective(target, direction, 20);

  const back = switchProjection(
    switchProjection(from, target, "orthographic", SIZE),
    target,
    "perspective",
    SIZE,
  );

  expectClose(back.position, from.position);
  expectClose(looking(back), looking(from));
  expect((back as PerspectiveCamera).fov).toBe(VIEW_FOV);
  expect((back as PerspectiveCamera).aspect).toBeCloseTo(
    SIZE.width / SIZE.height,
    12,
  );
});

test("a camera already in the projection asked for is refused", () => {
  const from = perspective(target, direction, 20);
  expect(() => switchProjection(from, target, "perspective", SIZE)).toThrow();
});

test("viewDistance: the perspective distance that shows the same view", () => {
  const from = perspective(target, direction, 20);
  expect(viewDistance(from, target)).toBeCloseTo(20, 9);
  const ortho = switchProjection(from, target, "orthographic", SIZE);
  expect(viewDistance(ortho, target)).toBeCloseTo(20, 9);
});

// The orthographic camera stands well back of the target: picking casts rays
// from the camera's plane, so a model part behind the camera could neither be
// seen nor picked.
test("orthographic: the model around the target is in front of the camera and inside the depth range", () => {
  for (const camera of [
    new PerspectiveCamera(VIEW_FOV, SIZE.width / SIZE.height, 0.1, 1000),
    new OrthographicCamera(-400, 400, 300, -300, 0.1, 1000),
  ]) {
    camera.up.copy(UP);
    // Fit a 10-unit sphere at the target, as Fit View does.
    const radius = 10;
    placeCamera(camera, target, direction, fitDistance(radius, SIZE), SIZE);
    camera.updateMatrixWorld();
    for (const offset of [radius, -radius]) {
      const point = target.clone().addScaledVector(direction, offset);
      const ndc = onScreen(camera, point);
      expect(ndc.z).toBeGreaterThan(-1);
      expect(ndc.z).toBeLessThan(1);
    }
  }
});

test("placeCamera frames the same view height in both projections", () => {
  const persp = new PerspectiveCamera(
    VIEW_FOV,
    SIZE.width / SIZE.height,
    1,
    10,
  );
  const ortho = new OrthographicCamera(-400, 400, 300, -300, 0.1, 10);
  for (const camera of [persp, ortho]) {
    camera.up.copy(UP);
    placeCamera(camera, target, direction, 30, SIZE);
  }
  for (const point of inTargetPlane(persp, target)) {
    const seen = onScreen(persp, point);
    const parallel = onScreen(ortho, point);
    expect(parallel.x).toBeCloseTo(seen.x, 9);
    expect(parallel.y).toBeCloseTo(seen.y, 9);
  }
});

test("fitDistance fits the narrower side: the width on a phone held upright", () => {
  const halfTan = Math.tan((VIEW_FOV * Math.PI) / 360);
  expect(fitDistance(10, { width: 800, height: 600 })).toBeCloseTo(
    10 / halfTan,
    9,
  );
  expect(fitDistance(10, { width: 300, height: 600 })).toBeCloseTo(
    10 / (halfTan * 0.5),
    9,
  );
});

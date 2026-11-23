// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Everything a spec does to the 3D viewport goes through this file.
//
// The viewport renders on demand, and its scene catches up with the store in
// a task of its own. A test that projects a point or clicks the canvas while
// that is pending acts on a view the user never saw: the click lands where
// the old camera put the point, or on a surface that has no pick handler yet.
// That was the flaky class of browser test. Every helper here first waits for
// one signal instead, `settled()` of the viewport's test hooks: the scene
// shows the store as it is, and nothing is still moving.
//
// Specs do not call `page.mouse` on the canvas themselves (the lint rule
// kofem/viewport-through-fixture), so no test can skip the wait.

import type { Page } from "@playwright/test";
import type {
  ViewCamera,
  ViewportHooks,
} from "../../src/components/viewport/ViewportTestHooks";

/** A point in model space, in mm. */
export type Point = [number, number, number];

type ViewportWindow = { __kofemViewport: ViewportHooks };

/**
 * Wait until the viewport shows the store as it is now and has stopped
 * drawing. Call it before reading anything off the canvas (a screenshot, a
 * pixel); the helpers below call it themselves.
 */
export async function settleViewport(page: Page): Promise<void> {
  // The hooks mount with the canvas, after the app has started.
  await page.waitForFunction(() =>
    Boolean((window as unknown as Partial<ViewportWindow>).__kofemViewport),
  );
  await page.evaluate(() =>
    (window as unknown as ViewportWindow).__kofemViewport.settled(),
  );
}

/**
 * Where a model-space point lands on the page, in client pixels, once the
 * viewport has settled. Null when the point is behind the camera.
 */
export async function projectPoint(
  page: Page,
  point: Point,
): Promise<{ x: number; y: number } | null> {
  await settleViewport(page);
  return page.evaluate(
    (target) =>
      (window as unknown as ViewportWindow).__kofemViewport.project(target),
    point,
  );
}

/**
 * Where each model-space point lands on the page, in client pixels, once the
 * viewport has settled: projectPoint for many points in one round trip.
 */
export async function projectPoints(
  page: Page,
  points: Point[],
): Promise<({ x: number; y: number } | null)[]> {
  await settleViewport(page);
  return page.evaluate(
    (targets) =>
      targets.map((target) =>
        (window as unknown as ViewportWindow).__kofemViewport.project(target),
      ),
    points,
  );
}

/**
 * Click the page at (x, y), a pixel of the viewport canvas, once the viewport
 * has settled, and wait until it has drawn what the click changed.
 */
export async function clickViewportAt(
  page: Page,
  x: number,
  y: number,
): Promise<void> {
  await settleViewport(page);
  await page.mouse.click(x, y);
  await settleViewport(page);
}

/**
 * Click the model where `point` lands on screen: a user's click on the face
 * that point lies on.
 */
export async function clickModelAt(page: Page, point: Point): Promise<void> {
  const screen = await projectPoint(page, point);
  if (!screen) throw new Error(`point ${point} is behind the camera`);
  await page.mouse.click(screen.x, screen.y);
  await settleViewport(page);
}

/**
 * Turn the camera to look at the orbit target from `direction`, keeping its
 * distance, and wait for that view.
 */
export async function lookFrom(page: Page, direction: Point): Promise<void> {
  await settleViewport(page);
  await page.evaluate(
    (from) =>
      (window as unknown as ViewportWindow).__kofemViewport.lookFrom(from),
    direction,
  );
  await settleViewport(page);
}

/**
 * The viewport camera once the viewport has settled: its kind (perspective or
 * orthographic), the direction it looks along and its orbit target.
 */
export async function viewCamera(page: Page): Promise<ViewCamera> {
  await settleViewport(page);
  return page.evaluate(() =>
    (window as unknown as ViewportWindow).__kofemViewport.camera(),
  );
}

/**
 * The vertex positions (x, y, z, …, in mm) of the viewport's visible meshes
 * named `name`, once it has settled — where the surface is drawn.
 */
export async function drawnPositions(
  page: Page,
  name: string,
): Promise<number[]> {
  await settleViewport(page);
  return page.evaluate(
    (target) =>
      (window as unknown as ViewportWindow).__kofemViewport.drawnPositions(
        target,
      ),
    name,
  );
}

/**
 * How many line segments the viewport draws in its visible objects named
 * `name`, once it has settled — what an edge highlight shows on screen.
 */
export async function drawnSegments(page: Page, name: string): Promise<number> {
  await settleViewport(page);
  return page.evaluate(
    (target) =>
      (window as unknown as ViewportWindow).__kofemViewport.drawnSegments(
        target,
      ),
    name,
  );
}

/**
 * Drag across the viewport with the left button from `from` to `to` (client
 * pixels) in `steps` moves, as a user turns the view, and wait for the view
 * the drag left.
 */
export async function dragViewport(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 10,
): Promise<void> {
  await settleViewport(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  await settleViewport(page);
}

/**
 * Move the mouse from `from` to `to` (client pixels) in `steps` moves with no
 * button pressed, as a user's cursor passes over the viewport, and wait for
 * whatever view that leaves.
 */
export async function hoverViewport(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 10,
): Promise<void> {
  await settleViewport(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.move(to.x, to.y, { steps });
  await settleViewport(page);
}

/** One finger on the screen: its id and where it is, in client pixels. */
export type Finger = { id: number; x: number; y: number };

/**
 * Touch the page as a phone does: each frame is a touch event, `start`,
 * `move` or `end`, and lists every finger still on the screen after it (for
 * `end`, the fingers left). Waits for the view the touches left. Needs a
 * page with touch (`test.use({ hasTouch: true })`).
 */
export async function touchViewport(
  page: Page,
  frames: { type: "start" | "move" | "end"; fingers: Finger[] }[],
): Promise<void> {
  await settleViewport(page);
  const cdp = await page.context().newCDPSession(page);
  const types = {
    start: "touchStart",
    move: "touchMove",
    end: "touchEnd",
  } as const;
  for (const frame of frames)
    await cdp.send("Input.dispatchTouchEvent", {
      type: types[frame.type],
      touchPoints: frame.fingers,
    });
  await cdp.detach();
  await settleViewport(page);
}

/**
 * Turn the mouse wheel by `deltaY` with the cursor at `at` (client pixels),
 * as a user zooms, and wait for the view the zoom left.
 */
export async function wheelViewportAt(
  page: Page,
  at: { x: number; y: number },
  deltaY: number,
): Promise<void> {
  await settleViewport(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, deltaY);
  await settleViewport(page);
}

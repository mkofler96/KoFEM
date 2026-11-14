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
import type { ViewportHooks } from "../../src/components/viewport/ViewportTestHooks";

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

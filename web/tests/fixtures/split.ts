// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Driving the Geometry step's split tool the way a user does: import a STEP
// file, click faces in the viewport, cut them with a plane.

import { expect, type Page } from "@playwright/test";
import { gotoApp } from "./app";

export type Point = [number, number, number];

// Import STEP text through the Geometry panel's import card.
export async function importStepText(page: Page, step: string): Promise<void> {
  await gotoApp(page);
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles({
    name: "model.step",
    mimeType: "application/step",
    buffer: Buffer.from(step),
  });
  await expect(
    page.getByRole("button").filter({ hasText: "Mesh STEP volume" }),
  ).toBeVisible({ timeout: 60_000 });
}

// Distinct CAD faces of the geometry, and how many bodies it has.
export function geometryCounts(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            stepSurface: { faceIds?: number[] } | null;
            properties: unknown[];
            geometryHistory: unknown[];
          };
        };
      }
    ).__kofemStore.getState();
    return {
      faces: new Set(state.stepSurface?.faceIds).size,
      bodies: state.properties.length,
      edits: state.geometryHistory.length,
    };
  });
}

// Click the model where `point` (mm) lands on screen — a user's click on the
// face that point lies on.
export async function clickModelAt(page: Page, point: Point): Promise<void> {
  await page.waitForFunction(
    () =>
      !!(window as unknown as { __kofemViewport?: unknown }).__kofemViewport,
  );
  const screen = await page.evaluate(
    (p) =>
      (
        window as unknown as {
          __kofemViewport: {
            project(p: Point): { x: number; y: number } | null;
          };
        }
      ).__kofemViewport.project(p),
    point,
  );
  if (!screen) throw new Error(`point ${point} is behind the camera`);
  await page.mouse.click(screen.x, screen.y);
}

export async function lookFrom(page: Page, direction: Point): Promise<void> {
  await page.evaluate(
    (d) =>
      (
        window as unknown as {
          __kofemViewport: { lookFrom(d: Point): void };
        }
      ).__kofemViewport.lookFrom(d),
    direction,
  );
}

// Pick the face under `point`, cut it with `x = position`, wait for the edit.
export async function splitFaceAt(
  page: Page,
  point: Point,
  position: number,
): Promise<void> {
  const before = (await geometryCounts(page)).edits;
  await page.getByTestId("split-axis").selectOption("x");
  await page.getByTestId("split-position").fill(String(position));
  await clickModelAt(page, point);
  await expect(page.locator('[data-testid^="split-face-"]')).toHaveCount(1);
  await page.getByTestId("split-apply").click();
  await expect
    .poll(async () => (await geometryCounts(page)).edits, { timeout: 30_000 })
    .toBe(before + 1);
}

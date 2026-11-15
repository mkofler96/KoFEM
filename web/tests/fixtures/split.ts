// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Driving the Geometry step's split tool the way a user does: import a STEP
// file, click faces in the viewport, cut them with a plane.

import { expect, type Page } from "@playwright/test";
import { gotoApp } from "./app";
import { clickModelAt, type Point } from "./viewport";

// Import STEP text through the Geometry panel's import card.
export async function importStepText(page: Page, step: string): Promise<void> {
  await gotoApp(page);
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles({
    name: "model.step",
    mimeType: "application/step",
    buffer: Buffer.from(step),
  });
  await expect(
    page.getByRole("button").filter({ hasText: "Generate mesh" }),
  ).toBeVisible();
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
    .poll(async () => (await geometryCounts(page)).edits)
    .toBe(before + 1);
}

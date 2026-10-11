// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Geometry → + Add → From boolean: combining bodies of the imported model
// through the engine's boolean_geometry.

import path from "path";
import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { importStep } from "./fixtures/app";
import { geometryCounts } from "./fixtures/split";

// Two boxes sharing a face: they touch but do not overlap.
const TWO_BOXES = path.resolve("..", "test_files", "two_boxes.stp");

async function openBoolean(page: Page): Promise<void> {
  await importStep(page, TWO_BOXES);
  expect((await geometryCounts(page)).bodies).toBe(2);
  await page.getByTestId("tree-add-geometry").click();
  await page.getByTestId("add-geometry-boolean").click();
}

test("a union fuses two touching bodies into one, and undo restores both", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openBoolean(page);

  await page.getByTestId("boolean-op-union").click();
  await page.getByTestId("boolean-tool-2").check();
  await page.getByTestId("boolean-apply").click();
  await expect
    .poll(async () => (await geometryCounts(page)).bodies, { timeout: 60_000 })
    .toBe(1);
  await expect(page.getByTestId("tree-body-2")).toHaveCount(0);

  await page.getByTestId("boolean-undo").click();
  await expect.poll(async () => (await geometryCounts(page)).bodies).toBe(2);
});

test("a Boolean that would change nothing is refused by name", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openBoolean(page);

  // Touching is not overlapping: there is no common volume…
  await page.getByTestId("boolean-op-intersect").click();
  await page.getByTestId("boolean-tool-2").check();
  await page.getByTestId("boolean-apply").click();
  await expect(page.getByTestId("boolean-error")).toContainText(
    "Body 1 and Body 2 do not overlap",
    { timeout: 60_000 },
  );

  // …and nothing to cut away.
  await page.getByTestId("boolean-op-subtract").click();
  await page.getByTestId("boolean-apply").click();
  await expect(page.getByTestId("boolean-error")).toContainText(
    "Body 2 does not overlap Body 1",
    { timeout: 60_000 },
  );
  expect((await geometryCounts(page)).bodies).toBe(2);
});

test("a single-body part has nothing to combine", async ({ page }) => {
  await importStep(page, path.resolve("..", "test_files", "Wall Bracket.stp"));
  await page.getByTestId("tree-add-geometry").click();
  await page.getByTestId("add-geometry-boolean").click();
  await expect(page.getByTestId("boolean-needs-bodies")).toBeVisible();
});

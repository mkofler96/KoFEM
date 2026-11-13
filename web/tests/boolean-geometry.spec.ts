// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Geometry → + Add → From boolean: combining bodies of the imported model
// through the engine's boolean_geometry.

import path from "path";
import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { importStep } from "./fixtures/app";
import { geometryCounts } from "./fixtures/split";
import { addMaterial, openBody } from "./fixtures/tree";

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
  await openBoolean(page);

  await page.getByTestId("boolean-op-union").click();
  await page.getByTestId("boolean-tool-2").check();
  await page.getByTestId("boolean-apply").click();
  await expect.poll(async () => (await geometryCounts(page)).bodies).toBe(1);
  await expect(page.getByTestId("tree-body-2")).toHaveCount(0);

  await page.getByTestId("boolean-undo").click();
  await expect.poll(async () => (await geometryCounts(page)).bodies).toBe(2);
});

test("a Boolean that would change nothing is refused by name", async ({
  page,
}) => {
  await openBoolean(page);

  // Touching is not overlapping: there is no common volume…
  await page.getByTestId("boolean-op-intersect").click();
  await page.getByTestId("boolean-tool-2").check();
  await page.getByTestId("boolean-apply").click();
  await expect(page.getByTestId("boolean-error")).toContainText(
    "Body 1 and Body 2 do not overlap",
  );

  // …and nothing to cut away.
  await page.getByTestId("boolean-op-subtract").click();
  await page.getByTestId("boolean-apply").click();
  await expect(page.getByTestId("boolean-error")).toContainText(
    "Body 2 does not overlap Body 1",
  );
  expect((await geometryCounts(page)).bodies).toBe(2);
});

test("a single-body part has nothing to combine", async ({ page }) => {
  await importStep(page, path.resolve("..", "test_files", "Wall Bracket.stp"));
  await page.getByTestId("tree-add-geometry").click();
  await page.getByTestId("add-geometry-boolean").click();
  await expect(page.getByTestId("boolean-needs-bodies")).toBeVisible();
});

test("bodies keep their settings when a Boolean renumbers them", async ({
  page,
}) => {
  await importStep(page, TWO_BOXES);
  // Three bodies: cut the second box (x 20–40) in two at x = 30.
  await openBody(page, 2);
  await page.getByTestId("split-open").click();
  await page.getByTestId("split-mode-bodies").click();
  await page.getByTestId("split-axis").selectOption("x");
  await page.getByTestId("split-position").fill("30");
  await page.getByTestId("split-apply").click();
  await expect.poll(async () => (await geometryCounts(page)).bodies).toBe(3);
  // The Boolean picker names the solids as the tree does, so a region of
  // the split body is never mistaken for another body.
  await page.getByTestId("tree-add-geometry").click();
  await page.getByTestId("add-geometry-boolean").click();
  await expect(page.getByTestId("boolean-target").locator("option")).toHaveText(
    ["Body 1", "Body 2 · Region 1", "Body 2 · Region 2"],
  );

  // The split made two regions of Body 2 (KOF-257); promote the second to
  // Body 3 of its own.
  await page.getByTestId("tree-region-3").click();
  await page.getByTestId("region-promote-3").click();
  await expect(page.getByTestId("tree-body-3")).toBeVisible();

  // Body 3 gets a material of its own and is suppressed.
  await addMaterial(page);
  await page
    .getByTestId("material-color")
    .locator("xpath=ancestor::div[contains(@class,'inlineForm')]")
    .getByRole("button", { name: "Save" })
    .click();
  await openBody(page, 3);
  await page.getByTestId("body-material-3").selectOption("2");
  await page.getByTestId("body-suppressed-3").check();

  // Fusing Bodies 1 and 2 moves the former Body 3 up to Body 2 — with its
  // material and its suppression, not the defaults.
  await page.getByTestId("tree-add-geometry").click();
  await page.getByTestId("add-geometry-boolean").click();
  await page.getByTestId("boolean-op-union").click();
  await page.getByTestId("boolean-tool-2").check();
  await page.getByTestId("boolean-apply").click();
  await expect.poll(async () => (await geometryCounts(page)).bodies).toBe(2);
  const bodies = await page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: {
            getState(): {
              properties: {
                id: number;
                materialId: number;
                suppressed?: boolean;
              }[];
            };
          };
        }
      ).__kofemStore.getState().properties,
  );
  expect(
    bodies.map((p) => ({
      id: p.id,
      materialId: p.materialId,
      suppressed: p.suppressed === true,
    })),
  ).toEqual([
    { id: 1, materialId: 1, suppressed: false },
    { id: 2, materialId: 2, suppressed: true },
  ]);
  // The bodies are numbered 1, 2 again — no gap where the fused one was.
  await expect(page.getByTestId("tree-body-2")).toBeVisible();
  await expect(page.getByTestId("tree-body-3")).toHaveCount(0);
});

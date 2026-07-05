// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Per-body material assignment UI (issue #353): importing a two-body assembly
// lists one body per solid, each with a material colour swatch, a material
// dropdown, and an eye control to hide it; hovering a body highlights it.

import { test, expect } from "@playwright/test";
import path from "path";
import { importStep } from "./fixtures/app";

interface Store {
  getState(): {
    properties: { id: number; materialId: number }[];
    materials: { id: number; name: string; color: string }[];
    highlightBodyId: number | null;
    hiddenBodyIds: number[];
  };
}
const store = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    (window as unknown as { __kofemStore: Store }).__kofemStore.getState(),
  );

// Playwright runs from web/; test_files sits one level up (see screenshot.spec).
const TWO_BOXES = path.resolve("..", "test_files", "two_boxes.stp");

test("two-body assembly lists per-body materials with colours", async ({
  page,
}) => {
  await importStep(page, TWO_BOXES);

  // One property (body) per solid, each defaulting to the sole material.
  const state = await store(page);
  expect(state.properties).toHaveLength(2);
  expect(state.properties.map((p) => p.id).sort()).toEqual([1, 2]);

  // Both body rows render with a material dropdown.
  await expect(page.getByTestId("body-material-1")).toBeVisible();
  await expect(page.getByTestId("body-material-2")).toBeVisible();
});

test("hovering a body highlights it; the eye hides it", async ({ page }) => {
  await importStep(page, TWO_BOXES);

  const body2Row = page
    .getByTestId("body-material-2")
    .locator("xpath=ancestor::div[1]");

  // Hover → the body is highlighted in the store (viewport dims the others).
  await body2Row.hover();
  await expect.poll(async () => (await store(page)).highlightBodyId).toBe(2);

  // Eye toggle hides the body, and clicking again shows it.
  await page.getByTestId("body-visibility-2").click();
  await expect.poll(async () => (await store(page)).hiddenBodyIds).toEqual([2]);
  await page.getByTestId("body-visibility-2").click();
  await expect.poll(async () => (await store(page)).hiddenBodyIds).toEqual([]);
});

test("adding a material auto-assigns a distinct colour", async ({ page }) => {
  await importStep(page, TWO_BOXES);

  const before = await store(page);
  const firstColor = before.materials[0].color;

  await page.getByTestId("add-material").click();
  // The new material's colour picker is pre-filled with a palette colour that
  // differs from the existing material.
  const colorInput = page.getByTestId("material-color");
  await expect(colorInput).toBeVisible();
  const picked = await colorInput.inputValue();
  expect(picked.toLowerCase()).not.toBe(firstColor.toLowerCase());

  // Save it (scoped to the material form — the app chrome has its own Save),
  // then assign body 2 to it and confirm the mapping changed.
  const form = colorInput.locator(
    "xpath=ancestor::div[contains(@class,'inlineForm')]",
  );
  await form.getByRole("button", { name: "Save" }).click();
  const after = await store(page);
  expect(after.materials).toHaveLength(2);

  await page
    .getByTestId("body-material-2")
    .selectOption(String(after.materials[1].id));
  const assigned = await store(page);
  expect(assigned.properties.find((p) => p.id === 2)?.materialId).toBe(
    after.materials[1].id,
  );
});

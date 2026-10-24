// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect, type Page } from "./coverage";
import { gotoApp } from "./fixtures/app";

async function asideWidth(page: Page): Promise<number> {
  const box = await page.locator("aside").boundingBox();
  if (!box) throw new Error("sidebar is not visible");
  return Math.round(box.width);
}

// The panel is docked right with its handle on the left edge, so a positive
// `widen` drags left.
async function dragHandleBy(page: Page, widen: number): Promise<void> {
  const box = await page.locator('[aria-label="Resize sidebar"]').boundingBox();
  if (!box) throw new Error("resize handle is not visible");
  const grabX = box.x + box.width / 2;
  await page.mouse.move(grabX, 400);
  await page.mouse.down();
  await page.mouse.move(grabX - widen, 400, { steps: 8 });
  await page.mouse.up();
}

test("drag resizes the sidebar and clamps to min/max", async ({ page }) => {
  await gotoApp(page);
  expect(await asideWidth(page)).toBe(340);

  await dragHandleBy(page, 140);
  expect(await asideWidth(page)).toBe(480);

  await dragHandleBy(page, 600);
  expect(await asideWidth(page)).toBe(560);
  await dragHandleBy(page, -500);
  expect(await asideWidth(page)).toBe(260);
});

test("width survives a reload; double-click resets it", async ({ page }) => {
  await gotoApp(page);
  await dragHandleBy(page, 80);
  expect(await asideWidth(page)).toBe(420);

  await page.reload();
  await expect(page.locator("nav")).toBeVisible();
  expect(await asideWidth(page)).toBe(420);

  await page.locator('[aria-label="Resize sidebar"]').dblclick();
  expect(await asideWidth(page)).toBe(340);
});

test("a garbage stored width falls back to the default", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("kofem.sidebarWidth", "banana"),
  );
  await gotoApp(page);
  expect(await asideWidth(page)).toBe(340);
});

test("footer button collapses, floating button expands", async ({ page }) => {
  await gotoApp(page);

  await page.getByRole("button", { name: "Hide panel" }).click();
  await expect(page.locator("aside")).toBeHidden();

  await page.getByRole("button", { name: "Show panel" }).click();
  await expect(page.locator("aside")).toBeVisible();
});

test("auto-collapses and reopens when crossing the breakpoint", async ({
  page,
}) => {
  await gotoApp(page);
  await expect(page.locator("aside")).toBeVisible();

  await page.setViewportSize({ width: 700, height: 800 });
  await expect(page.locator("aside")).toBeHidden();

  await page.setViewportSize({ width: 1100, height: 800 });
  await expect(page.locator("aside")).toBeVisible();
});

test.describe("small screens", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("starts collapsed and opens as an overlay with backdrop close", async ({
    page,
  }) => {
    // On a phone the consent banner spans the bottom edge, over the button.
    // It only exists when a GA ID is configured (locally via web/.env, not in
    // CI), so answer it up front instead of clicking it.
    await page.addInitScript(() =>
      localStorage.setItem("kofem_analytics_consent", "denied"),
    );
    await page.goto("/app/");
    const expandBtn = page.getByRole("button", { name: "Show panel" });
    await expect(expandBtn).toBeVisible();
    await expect(page.locator("aside")).toBeHidden();

    await expandBtn.click();
    const width = await asideWidth(page);
    expect(width).toBeGreaterThan(300);
    expect(width).toBeLessThan(360);

    // The drawer opens from the right; the backdrop is the strip left of it.
    await page.mouse.click(15, 400);
    await expect(page.locator("aside")).toBeHidden();
  });
});

test("the tree opens one entry at a time in the panel", async ({ page }) => {
  await gotoApp(page);
  const title = page.getByTestId("panel-title");
  // A fresh workspace opens on Geometry → + Add: the import cards.
  await expect(title).toHaveText("Add geometry");
  await expect(page.getByRole("button", { name: "Import STEP" })).toBeVisible();

  await page.getByTestId("tree-add-materials").click();
  await expect(title).toHaveText("New material");
  await expect(page.getByTestId("material-color")).toBeVisible();
  await expect(page.getByRole("button", { name: "Import STEP" })).toBeHidden();

  // An existing object opens its own editor.
  await page.getByTestId("tree-material-1").click();
  await expect(page.getByTestId("panel-title")).not.toHaveText("New material");
  await expect(
    page.getByRole("button", { name: "Remove material" }),
  ).toHaveCount(0);

  // A tree pick reopens a collapsed panel.
  await page.getByRole("button", { name: "Hide panel" }).click();
  await expect(page.locator("aside")).toBeHidden();
  await page.getByTestId("tree-add-studies").click();
  await expect(page.locator("aside")).toBeVisible();
  await expect(title).toHaveText("New study");

  // An optimization works on a static case, so it is offered once there is one.
  await expect(page.getByTestId("add-study-topopt")).toBeDisabled();
  await page.getByTestId("add-study-static").click();
  await expect(title).toHaveText("Static 1");
  await page.getByTestId("tree-add-studies").click();
  await page.getByTestId("add-study-topopt").click();
  await expect(page.getByTestId("add-study-static-case")).toHaveValue("1");
  await page.getByTestId("add-study-create").click();
  await expect(title).toHaveText("Optimization 1");
  await expect(page.getByTestId("study-static-case")).toHaveValue("1");

  // Deleting its static case leaves the optimization unable to run.
  await page.getByTestId("tree-study-1").click();
  await page.getByTestId("delete-study").click();
  await page.getByTestId("tree-study-2").click();
  await expect(page.getByTestId("study-static-case")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Run optimization" }),
  ).toBeDisabled();
});

test("saving a new material selects it", async ({ page }) => {
  await gotoApp(page);
  await page.getByTestId("tree-add-materials").click();
  await page
    .getByTestId("material-color")
    .locator("xpath=ancestor::div[contains(@class,'inlineForm')]")
    .getByRole("button", { name: "Save" })
    .click();
  await expect(page.getByTestId("tree-material-2")).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("dividers collapse their entries and select nothing", async ({ page }) => {
  await gotoApp(page);
  const title = page.getByTestId("panel-title");
  await expect(page.getByTestId("tree-add-mesh")).toBeVisible();
  await page.getByTestId("tree-group-mesh").click();
  await expect(page.getByTestId("tree-add-mesh")).toBeHidden();
  await expect(title).toHaveText("Add geometry");
  await page.getByTestId("tree-group-mesh").click();
  await expect(page.getByTestId("tree-add-mesh")).toBeVisible();
});

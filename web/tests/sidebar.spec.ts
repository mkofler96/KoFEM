// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect, type Page } from "./coverage";
import { gotoApp } from "./fixtures/app";

// Sidebar resize / collapse behavior (issue #339): drag-to-resize with
// clamping and persistence on desktop, collapse to a floating expand button,
// and the small-screen overlay mode with its auto-collapse breakpoint.

async function asideWidth(page: Page): Promise<number> {
  const box = await page.locator("aside").boundingBox();
  if (!box) throw new Error("sidebar is not visible");
  return Math.round(box.width);
}

async function dragHandleBy(page: Page, dx: number): Promise<void> {
  const box = await page.locator('[aria-label="Resize sidebar"]').boundingBox();
  if (!box) throw new Error("resize handle is not visible");
  const grabX = box.x + box.width / 2;
  await page.mouse.move(grabX, 400);
  await page.mouse.down();
  await page.mouse.move(grabX + dx, 400, { steps: 8 });
  await page.mouse.up();
}

test("drag resizes the sidebar and clamps to min/max", async ({ page }) => {
  await gotoApp(page);
  expect(await asideWidth(page)).toBe(340);

  await dragHandleBy(page, 140);
  expect(await asideWidth(page)).toBe(480);

  // Overshooting either way clamps to the [260, 560] range.
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
    await page.goto("/app/");
    // Collapsed on load: no panel, just the expand button.
    const expandBtn = page.getByRole("button", { name: "Show panel" });
    await expect(expandBtn).toBeVisible();
    await expect(page.locator("aside")).toBeHidden();

    await expandBtn.click();
    // Overlay width is min(85vw, 360px) — 331.5px at 390px viewport.
    const width = await asideWidth(page);
    expect(width).toBeGreaterThan(300);
    expect(width).toBeLessThan(360);

    // A click on the backdrop (right of the overlay) closes it.
    await page.mouse.click(375, 400);
    await expect(page.locator("aside")).toBeHidden();
  });
});

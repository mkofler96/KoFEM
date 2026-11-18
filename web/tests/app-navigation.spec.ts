// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { gotoApp } from "./fixtures/app";

// The way out of the app (KOF-381): the logo goes home, and the top-bar menu
// links to the public site and, after `?example=<id>`, back to that example's
// page. Leaving with an analysis open asks first, like "New analysis".

function siteMenu(page: Page) {
  return page.getByRole("menu", { name: "Site" });
}

async function openSiteMenu(page: Page) {
  await page.getByRole("button", { name: "Site menu" }).click();
  await expect(siteMenu(page)).toBeVisible();
}

async function openExample(page: Page, id: string) {
  await page.goto(`/app/?example=${id}`);
  // The top bar, not the model tree: phones have no tree column.
  await expect(page.getByRole("banner")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __kofemStore: { getState(): { nodes: unknown[] } };
            }
          ).__kofemStore.getState().nodes.length,
      ),
    )
    .toBeGreaterThan(0);
}

test("the logo links to the home page", async ({ page }) => {
  await gotoApp(page);
  await expect(
    page.getByRole("banner").getByRole("link", { name: "KoFEM home" }),
  ).toHaveAttribute("href", "/");
});

test("the site menu links to the examples, the theory and home", async ({
  page,
}) => {
  await gotoApp(page);
  await openSiteMenu(page);
  const menu = siteMenu(page);
  await expect(
    menu.getByRole("menuitem", { name: "Examples", exact: true }),
  ).toHaveAttribute("href", "/examples/");
  await expect(
    menu.getByRole("menuitem", { name: "Theory", exact: true }),
  ).toHaveAttribute("href", "/theory/");
  await expect(
    menu.getByRole("menuitem", { name: "Home", exact: true }),
  ).toHaveAttribute("href", "/");
  // Opened without an example: no way back to one.
  await expect(menu.getByRole("menuitem", { name: /^Back to/ })).toHaveCount(0);
});

test("an empty workspace leaves for the site without asking", async ({
  page,
}) => {
  await gotoApp(page);
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected dialog: ${dialog.message()}`);
  });
  await openSiteMenu(page);
  await siteMenu(page)
    .getByRole("menuitem", { name: "Examples", exact: true })
    .click();
  await expect(page).toHaveURL("/examples/");
});

test("an app opened from an example leads back to its page", async ({
  page,
}) => {
  await openExample(page, "plate-with-hole");
  let asked = "";
  page.once("dialog", async (dialog) => {
    asked = dialog.message();
    await dialog.accept();
  });
  await openSiteMenu(page);
  const back = siteMenu(page).getByRole("menuitem", {
    name: "Back to Plate with a hole",
  });
  await expect(back).toHaveAttribute("href", "/examples/plate-with-hole/");
  await back.click();
  await expect(page).toHaveURL("/examples/plate-with-hole/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Plate with a hole" }),
  ).toBeVisible();
  expect(asked).toContain("Leave the app?");
});

test("declining to leave keeps the analysis open", async ({ page }) => {
  await openExample(page, "plate-with-hole");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("banner")
    .getByRole("link", { name: "KoFEM home" })
    .click();
  await expect(page).toHaveURL("/app/?example=plate-with-hole");
  await expect(page.getByRole("menu", { name: "Site" })).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __kofemStore: { getState(): { nodes: unknown[] } };
          }
        ).__kofemStore.getState().nodes.length,
    ),
  ).toBeGreaterThan(0);
});

for (const width of [320, 390]) {
  test(`the site menu fits a ${width}px screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openExample(page, "plate-with-hole");
    for (const button of ["Site menu", "Save analysis", "Load analysis"])
      await expect(page.getByRole("button", { name: button })).toBeInViewport({
        ratio: 1,
      });
    await openSiteMenu(page);
    for (const item of await siteMenu(page).getByRole("menuitem").all())
      await expect(item).toBeInViewport({ ratio: 1 });
  });
}

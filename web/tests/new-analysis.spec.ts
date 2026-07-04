// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";

// Coverage for the TopBar "New analysis" button (issue #189): it confirms with
// the user when work would be lost, then resets the store to a fresh session.

type StoreSnapshot = {
  modelName: string;
  nodes: number;
  elements: number;
  hasResult: boolean;
  hasStarted: boolean;
  mode: string;
  bcGroups: number;
  loadGroups: number;
};

function readStore(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const s = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            modelName: string;
            nodes: unknown[];
            elements: unknown[];
            result: unknown;
            hasStarted: boolean;
            mode: string;
            bcGroups: unknown[];
            loadGroups: unknown[];
          };
        };
      }
    ).__kofemStore.getState();
    return {
      modelName: s.modelName,
      nodes: s.nodes.length,
      elements: s.elements.length,
      hasResult: s.result !== null,
      hasStarted: s.hasStarted,
      mode: s.mode,
      bcGroups: s.bcGroups.length,
      loadGroups: s.loadGroups.length,
    } satisfies StoreSnapshot;
  });
}

// Load a pre-solved example so the store carries a full analysis to discard.
async function loadExample(page: import("@playwright/test").Page) {
  await page.goto("/app/?example=cantilever-beam");
  await expect(page.locator("nav")).toBeVisible();
  await expect
    .poll(async () => (await readStore(page)).nodes, { timeout: 15_000 })
    .toBeGreaterThan(0);
}

test("New analysis confirms, then clears the loaded analysis", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await loadExample(page);

  let dialogMessage = "";
  page.on("dialog", (d) => {
    dialogMessage = d.message();
    void d.accept();
  });

  await page.getByRole("button", { name: "New analysis" }).click();

  expect(dialogMessage).toContain("Start a new analysis?");
  const s = await readStore(page);
  expect(s).toEqual({
    modelName: "",
    nodes: 0,
    elements: 0,
    hasResult: false,
    hasStarted: false,
    mode: "geometry",
    bcGroups: 0,
    loadGroups: 0,
  } satisfies StoreSnapshot);

  // Back to a fresh workspace: Untitled crumb and the import cards.
  await expect(page.getByText("Untitled")).toBeVisible();
  await expect(
    page.getByRole("button").filter({ hasText: "Import STEP" }),
  ).toBeVisible();
});

test("dismissing the confirm keeps the current analysis", async ({ page }) => {
  test.setTimeout(60_000);
  await loadExample(page);

  page.on("dialog", (d) => void d.dismiss());
  await page.getByRole("button", { name: "New analysis" }).click();

  const s = await readStore(page);
  expect(s.nodes).toBeGreaterThan(0);
  expect(s.modelName).toBe("Cantilever beam under tip load");
  expect(s.hasResult).toBe(true);
});

test("with an empty workspace no confirmation is asked", async ({ page }) => {
  await gotoApp(page);

  let dialogFired = false;
  page.on("dialog", (d) => {
    dialogFired = true;
    void d.accept();
  });

  await page.getByRole("button", { name: "New analysis" }).click();

  expect(dialogFired).toBe(false);
  expect((await readStore(page)).nodes).toBe(0);
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Supports, loads, ties and couplings are deleted straight from the model tree
// (KOF-423): hovering an entry shows a delete button at the row's end, so the
// user need not open the object first. Interfaces come from the geometry and
// cannot be deleted. Deleting the entry the panel shows sends the panel back
// to "Boundary conditions / Add".

import type { Page } from "@playwright/test";
import { test, expect } from "./coverage";
import { bootstrapCantilever } from "./fixtures/cantilever";

function groupIds(page: Page): Promise<{ bc: number[]; load: number[] }> {
  return page.evaluate(() => {
    const st = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            bcGroups: { id: number }[];
            loadGroups: { id: number }[];
          };
        };
      }
    ).__kofemStore.getState();
    return {
      bc: st.bcGroups.map((g) => g.id),
      load: st.loadGroups.map((g) => g.id),
    };
  });
}

const bcEntry = (page: Page) => page.locator('[data-testid^="tree-bc-"]');
const loadEntry = (page: Page) => page.locator('[data-testid^="tree-load-"]');
const bcDelete = (page: Page) =>
  page.locator('[data-testid^="tree-delete-bc-"]');

test("hovering a support shows its delete button, which deletes only that support", async ({
  page,
}) => {
  await bootstrapCantilever(page);
  const [loadId] = (await groupIds(page)).load;

  await expect(bcDelete(page)).toHaveCSS("opacity", "0");
  await bcEntry(page).hover();
  await expect(bcDelete(page)).toHaveCSS("opacity", "1");
  await expect(bcDelete(page)).toHaveAttribute("aria-label", "Delete BC1");

  await bcDelete(page).click();
  await expect(bcEntry(page)).toHaveCount(0);
  await expect(loadEntry(page)).toHaveText("Load1");
  expect(await groupIds(page)).toEqual({ bc: [], load: [loadId] });
});

test("deleting the open entry sends the panel back to Add", async ({
  page,
}) => {
  await bootstrapCantilever(page);
  await loadEntry(page).click();
  await expect(page.getByTestId("panel-title")).toHaveText("Load1");

  await loadEntry(page).hover();
  await page.locator('[data-testid^="tree-delete-load-"]').click();
  await expect(loadEntry(page)).toHaveCount(0);
  await expect(page.getByTestId("panel-title")).toHaveText(
    "Add boundary condition",
  );
  await expect(page.getByTestId("add-boundary-bc")).toBeVisible();
});

test("only boundary objects get a delete button", async ({ page }) => {
  await bootstrapCantilever(page);
  await expect(page.locator('[data-testid^="tree-delete-"]')).toHaveCount(2);
  await expect(
    page.locator('[data-testid^="tree-delete-material-"]'),
  ).toHaveCount(0);
  await expect(page.locator('[data-testid^="tree-delete-mesh-"]')).toHaveCount(
    0,
  );
});

test.describe("on a phone", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("the delete button shows without hovering", async ({ page }) => {
    await bootstrapCantilever(page);
    await page.getByRole("button", { name: "Show panel" }).click();
    await expect(bcDelete(page)).toHaveCSS("opacity", "1");
  });
});

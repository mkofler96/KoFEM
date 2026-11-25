// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-400: a nearly incompressible material on linear elements gets a
// pre-flight warning, as a thin wall does. The nearly incompressible Cook's
// membrane opens on quadratic tetrahedra (no warning); re-meshed with linear
// ones it locks, −43 % on its page, and the Solve panel says so. The warning
// does not block the solve.

import { test, expect } from "./coverage";
import { openTree } from "./fixtures/tree";

const WARNING = "Nearly incompressible material on body 1 (ν = 0.4999)";

const storeState = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const store = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            nodes: unknown[];
            isMeshing: boolean;
            elementOrder: number;
          };
        };
      }
    ).__kofemStore.getState();
    return {
      nodes: store.nodes.length,
      meshing: store.isMeshing,
      order: store.elementOrder,
    };
  });

test("linear elements on a nearly incompressible material get a warning that does not block the solve @pipeline", async ({
  page,
}) => {
  await page.goto("/app/?example=cooks-membrane-incompressible");
  await expect
    .poll(async () => (await storeState(page)).nodes)
    .toBeGreaterThan(0);

  await openTree(page, "static");
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  const warning = page.getByTestId("check-fail").filter({ hasText: WARNING });
  await expect(warning).toHaveCount(0);

  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill("2");
  await page.getByTestId("min-element-size").fill("0.2");
  await page
    .getByText("Element order", { exact: true })
    .locator("..")
    .locator("select")
    .selectOption("1");
  await page.getByTestId("mesh-generate").click();
  await expect
    .poll(async () => {
      const state = await storeState(page);
      return !state.meshing && state.order === 1;
    })
    .toBe(true);

  await openTree(page, "static");
  await expect(warning).toHaveCount(1);
  await expect(warning).toContainText("Use quadratic elements (Mesh panel).");
  await expect(run).toBeEnabled();
});

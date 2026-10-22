// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Studies and Results are built with "+ Add" like every other group: a static
// study is added and run, the run lands on a plot of its result, and further
// plots pick another field of the same result.

import { test, expect } from "./coverage";
import { bootstrapCantilever } from "./fixtures/cantilever";

type Store = {
  getState(): {
    resultType: string;
    activeResult: string;
    resultPlots: { id: number; source: string; field: string | null }[];
  };
};
const state = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const st = (
      window as unknown as { __kofemStore: Store }
    ).__kofemStore.getState();
    return {
      resultType: st.resultType,
      activeResult: st.activeResult,
      plots: st.resultPlots,
    };
  });

test("a static study runs and its result is plotted, field by field", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await bootstrapCantilever(page);
  const title = page.getByTestId("panel-title");

  // Nothing to plot before a run.
  await page.getByTestId("tree-add-results").click();
  await expect(page.getByTestId("add-plot-von-mises-stress")).toBeDisabled();

  await page.getByTestId("tree-add-studies").click();
  await page.getByTestId("add-study-static").click();
  await expect(title).toHaveText("Static 1");
  await expect(page.getByTestId("check-fail")).toHaveCount(0);
  await page.getByRole("button", { name: /Run static solve/ }).click();

  // The run lands on a plot of its displacement.
  await expect(title).toHaveText("Displacement (magnitude)", {
    timeout: 60_000,
  });
  expect((await state(page)).plots).toEqual([
    { id: 1, source: "static", field: "Displacement (magnitude)" },
  ]);

  // + Add → Von Mises stress: a second plot, shown as soon as it is made.
  await page.getByTestId("tree-add-results").click();
  await page.getByTestId("add-plot-von-mises-stress").click();
  await expect(title).toHaveText("Von Mises stress");
  expect((await state(page)).resultType).toBe("Von Mises stress");

  // Picking the first plot again puts its field back on the viewport.
  await page.getByTestId("tree-plot-1").click();
  expect((await state(page)).resultType).toBe("Displacement (magnitude)");

  // A plot's field can be changed in place; deleting it leaves the other.
  await page.getByTestId("plot-field").selectOption("Uy");
  await expect(page.getByTestId("tree-plot-1")).toHaveText("Uy");
  expect((await state(page)).resultType).toBe("Uy");
  await page.getByTestId("delete-plot").click();
  await expect(page.locator('[data-testid^="tree-plot-"]')).toHaveCount(1);
});

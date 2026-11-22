// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The result plot panel shows each thing once. The field's min and max are
// one block, always in the panel; its checkbox only labels them in the view.
// The deformation factor is one number box: clearing it returns to the
// automatic factor. The legend range is edited from a pencil on the legend,
// not in the panel. A section cut is a result output of its plot: added from
// Results → + Add, listed under the plot in the tree, with its own panel.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";

async function solveExample(page: Page, id: string): Promise<void> {
  await page.goto(`/app/?example=${id}`);
  await expect(page.locator("nav")).toBeVisible();
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("colorbar")).toBeVisible();
}

// The section the viewport draws, or null.
function drawnSection(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: { getState(): { section: unknown } };
        }
      ).__kofemStore.getState().section,
  );
}

test("the result plot panel shows the min and max once, and one deformation factor @pipeline", async ({
  page,
}) => {
  await solveExample(page, "axial-bar");
  await page.getByTestId("plot-field").selectOption("Ux");

  // One min/max block, no separate summary.
  await expect(page.getByText("Result summary")).toHaveCount(0);
  await expect(page.getByTestId("probe-value-max")).toContainText("mm");
  await expect(page.getByTestId("probe-value-min")).toContainText("mm");

  // Unticking the checkbox removes the labels from the view, not the values
  // from the panel.
  await page.getByTestId("probe-extremes").uncheck();
  await expect(page.getByTestId("probe-label-max")).toHaveCount(0);
  await expect(page.getByTestId("probe-value-max")).toBeVisible();
  await page.getByTestId("probe-extremes").check();
  await expect(page.getByTestId("probe-label-max")).toBeVisible();

  // The deformation factor is one number box, without presets.
  const slider = page.getByLabel("Deformation scale");
  const factor = page.getByLabel("Deformation factor");
  await expect(factor).toBeVisible();
  await expect(page.getByTestId("deform-scale-auto")).toHaveCount(0);
  await expect(page.getByTestId("deform-scale-true")).toHaveCount(0);
  await expect(slider).toHaveAttribute("aria-valuetext", /\(auto\)$/);
  await factor.fill("1");
  await expect(slider).toHaveAttribute("aria-valuetext", "×1 (true scale)");
  // Cleared, it goes back to the automatic factor.
  await factor.fill("");
  await factor.press("Enter");
  await expect(slider).toHaveAttribute("aria-valuetext", /\(auto\)$/);
  await expect(factor).not.toHaveValue("");
});

test("hovering a min, max or probe row shows its location over the panel, moving nothing @pipeline", async ({
  page,
}) => {
  await solveExample(page, "axial-bar");
  const min = page.getByTestId("probe-row-min");
  const max = page.getByTestId("probe-row-max");
  const location = page.getByTestId("probe-vector-min");
  const before = await max.boundingBox();
  await expect(location).toBeHidden();

  await min.hover();
  await expect(location).toBeVisible();
  await expect(location).toContainText("mm");
  // The row below stays where it was: the location covers it, not pushes it.
  expect(await max.boundingBox()).toEqual(before);
  // It sits below the row it belongs to, over what follows.
  const row = await min.boundingBox();
  const box = await location.boundingBox();
  if (!row || !box) throw new Error("probe row or its location not laid out");
  expect(box.y).toBeGreaterThanOrEqual(row.y + row.height - 1);

  // Moving to the next row, the overlay keeps its width and left edge.
  await max.hover();
  const next = await page.getByTestId("probe-vector-max").boundingBox();
  if (!next) throw new Error("the max row's location not laid out");
  expect(next.width).toBe(box.width);
  expect(next.x).toBe(box.x);
});

test("the legend range is edited from a pencil on the legend @pipeline", async ({
  page,
}) => {
  await solveExample(page, "axial-bar");
  await page.getByTestId("plot-field").selectOption("Ux");

  // Not in the panel.
  await expect(page.getByText("Legend range")).toHaveCount(0);
  await expect(page.getByTestId("legend-max")).toHaveCount(0);

  await page.getByTestId("legend-edit").click();
  const popup = page.getByRole("dialog", { name: "Legend range" });
  await expect(popup).toBeVisible();
  await expect(popup.getByTestId("legend-auto")).toHaveCount(0);
  await popup.getByTestId("legend-max").fill("0.3");
  await expect(page.getByTestId("colorbar-manual")).toBeVisible();
  await popup.getByTestId("legend-auto").click();
  await expect(page.getByTestId("colorbar-manual")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
});

test("a section cut is a result output: added under its plot, with its own panel @pipeline", async ({
  page,
}) => {
  await solveExample(page, "axial-bar");

  // Until it is added, there is no cut and no cut control.
  await expect(page.getByTestId("section-axis")).toHaveCount(0);
  await expect(page.getByTestId("tree-section-1")).toHaveCount(0);
  expect(await drawnSection(page)).toBeNull();

  // Results → + Add → Section cut: a cut of the plot on screen.
  await page.getByTestId("tree-add-results").click();
  await expect(page.getByTestId("add-plot-section")).toContainText(
    "Displacement (magnitude)",
  );
  await page.getByTestId("add-plot-section").click();

  // The cut is listed under the plot and its panel is open.
  await expect(page.getByTestId("tree-section-1")).toBeVisible();
  await expect(page.getByTestId("section-axis")).toHaveValue("x");
  await expect(page.getByLabel("Section position")).toBeVisible();
  await expect(page.getByTestId("section-flip")).toBeVisible();
  expect(await drawnSection(page)).not.toBeNull();

  // Back on the plot, the cut is still drawn; the plot panel has no cut
  // controls, and a plot takes one cut.
  await page.getByTestId("tree-plot-1").click();
  await expect(page.getByTestId("section-axis")).toHaveCount(0);
  expect(await drawnSection(page)).not.toBeNull();
  await page.getByTestId("tree-add-results").click();
  await expect(page.getByTestId("add-plot-section")).toBeDisabled();

  // Another plot has no cut of its own.
  await page.getByTestId("add-plot-ux").click();
  await expect(page.getByTestId("tree-plot-2")).toBeVisible();
  expect(await drawnSection(page)).toBeNull();

  // Deleting the cut from its panel removes the row and the cut.
  await page.getByTestId("tree-section-1").click();
  expect(await drawnSection(page)).not.toBeNull();
  await page.getByTestId("delete-section").click();
  await expect(page.getByTestId("tree-section-1")).toHaveCount(0);
  expect(await drawnSection(page)).toBeNull();
});

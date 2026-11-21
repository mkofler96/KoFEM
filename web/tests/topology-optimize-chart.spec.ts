// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A topology optimization reads like the mesh refinement study: Run hands off
// to Results → Density at once, and its panel switches the centre between the
// density in 3D and the convergence chart, drawn in place of the 3D view. That
// the run draws live there is topology-optimize-results.spec.ts's.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { bootstrapCantilever } from "./fixtures/cantilever";
import { openTree } from "./fixtures/tree";

async function runCapped(page: Page, maxIterations: string) {
  await bootstrapCantilever(page);
  await openTree(page, "topopt");
  await page.getByLabel("Filter r_min").fill("0.15");
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByLabel("Max iters").fill(maxIterations);
  // A tolerance no design meets in a few iterations: every run hits its cap.
  await page.getByLabel("Tolerance").fill("0.000001");
}

test("TO chart: Results switches between the density in 3D and the convergence chart @pipeline", async ({
  page,
}) => {
  page.on("pageerror", (e) =>
    console.error(`[to-chart] page error: ${e.message}`),
  );
  await runCapped(page, "4");

  // The run opens Results → Density straight away, on the density in 3D.
  // Waiting for the panel title here would only prove the hand-off once the
  // run had finished, so wait on the run's own end instead.
  await page.getByRole("button", { name: /Run optimization/ }).click();
  await expect(page.getByTestId("panel-title")).toHaveText("Density");
  await expect(page.getByText("Run summary")).toBeVisible();
  const densityRow = page.getByTestId("topopt-view-density");
  const chartRow = page.getByTestId("topopt-view-chart");
  await expect(densityRow).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("density-colorbar")).toBeVisible();
  await expect(page.getByTestId("topopt-chart")).toHaveCount(0);

  // The chart replaces the 3D view: one point per iteration, and the run's
  // verdict on top.
  await chartRow.click();
  await expect(chartRow).toHaveAttribute("aria-current", "true");
  const chart = page.getByTestId("topopt-chart");
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAttribute("data-points", "4");
  await expect(page.getByTestId("topopt-chart-status")).toContainText(
    "Not converged",
  );
  await expect(page.getByTestId("density-colorbar")).toHaveCount(0);

  // Compliance first; the volume fraction draws its target as a line.
  await expect(page.getByTestId("topopt-chart-bound")).toHaveCount(0);
  await chart.getByRole("button", { name: "Volume" }).click();
  await expect(page.getByTestId("topopt-chart-bound")).toHaveCount(1);

  // Back to 3D.
  await densityRow.click();
  await expect(page.getByTestId("topopt-chart")).toHaveCount(0);
  await expect(page.getByTestId("density-colorbar")).toBeVisible();
});

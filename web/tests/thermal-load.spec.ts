// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A temperature change (KOF-449): a material takes an expansion coefficient α,
// Boundary conditions → + Add → Temperature change takes a formula the Rust
// parser checks as it is typed, and the solid solve applies it. A shell model
// refuses it by name.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { addBoundary, openTree } from "./fixtures/tree";

async function openExample(page: Page, id: string): Promise<void> {
  await page.goto(`/app/?example=${id}`);
  // The example is loaded, not just the app: it opens on the static solve,
  // ready to run. A tree pick made earlier is replaced when it lands.
  await expect(
    page.getByRole("button", { name: /Run static solve/ }),
  ).toBeEnabled();
}

async function setExpansion(page: Page, alpha: string): Promise<void> {
  await page.getByTestId("tree-material-1").click();
  await page.getByTestId("material-expansion").fill(alpha);
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

async function addTemperature(page: Page, formula: string): Promise<void> {
  await addBoundary(page, "temperature");
  const input = page.getByTestId("temperature-formula");
  // A formula that does not parse is shown as such and cannot be applied.
  await input.fill("2 * (x +");
  await expect(page.getByTestId("temperature-error")).toBeVisible();
  await expect(page.getByTestId("temperature-apply")).toBeDisabled();
  await input.fill(formula);
  await expect(page.getByTestId("temperature-apply")).toBeEnabled();
  await page.getByTestId("temperature-apply").click();
  await expect(page.getByTestId("temperature-applied")).toContainText(formula);
  await expect(page.getByTestId("tree-temperature-1")).toBeVisible();
}

async function runSolve(page: Page): Promise<void> {
  await openTree(page, "static");
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
}

// The axial bar (1000 mm along x, clamped at x = 0, pulled by 1 MN) heated by
// 100 °C with α = 1.2e-5 /°C grows by α·ΔT·L = 1.2 mm on top of the load's
// P·L/(E·A) = 0.476 mm.
test("a temperature change expands a solid model @pipeline", async ({
  page,
}) => {
  await openExample(page, "axial-bar");
  await setExpansion(page, "1.2e-5");
  await addTemperature(page, "100");
  await runSolve(page);
  await expect(page.getByTestId("colorbar")).toBeVisible();
  await page.getByTestId("plot-field").selectOption("Ux");
  await page.getByTestId("probe-at-x").fill("1000");
  await page.getByTestId("probe-at-y").fill("50");
  await page.getByTestId("probe-at-z").fill("50");
  await page.getByTestId("probe-at-add").click();
  const value = Number(
    await page.getByTestId("probe-value-1").getAttribute("data-value"),
  );
  expect(value).toBeGreaterThan(1.6);
  expect(value).toBeLessThan(1.7);
});

test("a shell model refuses a temperature change @pipeline", async ({
  page,
}) => {
  await openExample(page, "plate-with-hole-shell");
  await setExpansion(page, "1.2e-5");
  await addTemperature(page, "50");
  await runSolve(page);
  await expect(
    page.getByText(/cannot take a temperature change/),
  ).toBeVisible();
});

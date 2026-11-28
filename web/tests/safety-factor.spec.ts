// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The safety factor against yield (KOF-496): a material's optional yield
// strength, set in its editor, gives Results the safety factor against the
// max and the 99th percentile von Mises. Without one, no factor is shown.
// Solid (the axial bar) and shell (the plate with a hole).

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

async function setYield(page: Page, value: string): Promise<void> {
  await page.getByTestId("tree-material-1").click();
  await page.getByTestId("material-yield").fill(value);
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

async function showVonMises(page: Page): Promise<void> {
  await page.getByTestId("tree-plot-1").click();
  await page.getByTestId("plot-field").selectOption("Von Mises stress");
}

async function readNumber(page: Page, testId: string): Promise<number> {
  const value = page.getByTestId(testId);
  await expect(value).toHaveAttribute("data-value", /\d/);
  return Number(await value.getAttribute("data-value"));
}

test("a yield strength gives the safety factor on the max and p99 von Mises @pipeline", async ({
  page,
}) => {
  await solveExample(page, "axial-bar");
  await page.getByTestId("plot-field").selectOption("Von Mises stress");
  // No yield strength, no factor.
  await expect(page.getByTestId("percentile-value-99")).toContainText("MPa");
  await expect(page.getByTestId("safety-factors")).toHaveCount(0);

  await setYield(page, "250");
  await showVonMises(page);
  const max = await readNumber(page, "probe-value-max");
  const p99 = await readNumber(page, "percentile-value-99");
  const onMax = await readNumber(page, "safety-factor-max-model");
  const onP99 = await readNumber(page, "safety-factor-p99-model");
  // σ = P / A = 100 MPa over almost all of the bar: about 2.5 against 250 MPa.
  expect(onP99).toBeCloseTo(250 / p99, 6);
  expect(Math.abs(onP99 - 2.5)).toBeLessThan(0.05);
  expect(onMax).toBeCloseTo(250 / max, 6);
  expect(onMax).toBeLessThanOrEqual(onP99);

  // Cleared again: no factor, never one against a default.
  await setYield(page, "");
  await showVonMises(page);
  await expect(page.getByTestId("percentile-value-99")).toContainText("MPa");
  await expect(page.getByTestId("safety-factors")).toHaveCount(0);
});

test("a shell model lists the safety factor too @pipeline", async ({
  page,
}) => {
  await solveExample(page, "plate-with-hole-shell");
  await setYield(page, "355");
  await showVonMises(page);
  const max = await readNumber(page, "probe-value-max");
  const onMax = await readNumber(page, "safety-factor-max-model");
  expect(onMax).toBeCloseTo(355 / max, 6);
});

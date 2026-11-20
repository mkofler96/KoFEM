// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Section plane (KOF-390): in Results, a plane along x, y or z cuts the model
// so the field inside it shows. The cut face is filled and coloured by the
// plotted field; the legend keeps referring to the whole model; the min and
// max on the cut can be shown. Shells are cut as lines.

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

async function cutValue(page: Page, end: "min" | "max"): Promise<number> {
  const value = page.getByTestId(`section-${end}`);
  await expect(value).toHaveAttribute("data-value", /\d/);
  return Number(await value.getAttribute("data-value"));
}

// The axial bar: 1000 × 100 × 100 mm along x, fixed at x = 0 and pulled by
// 1 MN at x = 1000. Away from the ends Ux grows linearly to the tip extension
// δ = P·L / (E·A), so on a cut at x = 500 it is δ/2 everywhere.
const DELTA = (1.0e6 * 1000) / (210000 * 100 * 100);

test("a section plane cuts the solved bar and shows the field on the cut @pipeline", async ({
  page,
}) => {
  await solveExample(page, "axial-bar");
  await page.getByTestId("plot-field").selectOption("Ux");
  await page.getByLabel("Deformation scale").fill("0");
  const legend = await page.getByTestId("colorbar").innerText();
  const canvas = page.locator("canvas").first();
  const whole = await canvas.screenshot();

  const axis = page.getByTestId("section-axis");
  await expect(axis).toHaveValue("off");
  await axis.selectOption("x");
  const position = page.getByLabel("Section position");
  await position.fill("0.5");
  await expect
    .poll(async () => (await canvas.screenshot()).equals(whole))
    .toBe(false);

  // The legend still spans the whole model.
  await expect(page.getByTestId("colorbar")).toHaveText(legend);

  // The min and max on the cut: Ux is δ/2 across the whole section.
  await page.getByTestId("section-range").check();
  expect(await cutValue(page, "min")).toBeCloseTo(DELTA / 2, 2);
  expect(await cutValue(page, "max")).toBeCloseTo(DELTA / 2, 2);

  // Flipping keeps the other half; the cut, and what it reads, stay.
  const flip = page.getByTestId("section-flip");
  await expect(flip).toHaveAttribute("aria-pressed", "false");
  await flip.click();
  await expect(flip).toHaveAttribute("aria-pressed", "true");
  expect(await cutValue(page, "max")).toBeCloseTo(DELTA / 2, 2);

  // Off restores the whole model, and the position has nothing to move.
  await axis.selectOption("off");
  await expect(position).toBeDisabled();
  await expect(page.getByTestId("section-min")).toHaveCount(0);
});

test("a shell model is cut as lines, coloured by the field @pipeline", async ({
  page,
}) => {
  await solveExample(page, "plate-with-hole-shell");
  await page.getByTestId("plot-field").selectOption("Von Mises stress");
  await page.getByTestId("section-axis").selectOption("y");
  await page.getByLabel("Section position").fill("0.5");
  await page.getByTestId("section-range").check();
  const min = await cutValue(page, "min");
  const max = await cutValue(page, "max");
  expect(max).toBeGreaterThan(min);
  await expect(page.getByTestId("section-max")).toContainText("MPa");
});

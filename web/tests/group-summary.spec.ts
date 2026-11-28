// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-494: each support and load card says what it applies, from the CAD face
// areas the status bar shows (KOF-493), and follows the value and the
// selection as they change. Driven on the axial bar example: a 1000 × 100 ×
// 100 mm bar along x, fixed on its x = 0 end and pulled with 1 MN on its
// x = 1000 end; each end is 100 × 100 = 10,000 mm², each side 100,000 mm².

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { clickModelAt, lookFrom } from "./fixtures/viewport";

async function openBar(page: Page): Promise<void> {
  await page.goto("/app/?example=axial-bar");
  await expect(page.locator("nav")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Run static solve/ }),
  ).toBeEnabled();
}

test("the support card says its area and the DOFs it holds @pipeline", async ({
  page,
}) => {
  await openBar(page);
  await page.locator('[data-testid^="tree-bc-"]').click();
  await expect(page.getByTestId("group-summary")).toHaveText(
    "10,000 mm² · holds Ux, Uy, Uz",
  );
});

test("the load card says its total, area and mean traction, and follows edits @pipeline", async ({
  page,
}) => {
  await openBar(page);
  await page.locator('[data-testid^="tree-load-"]').click();
  const summary = page.getByTestId("group-summary");
  // 1 MN over the 100 × 100 mm end: 100 MPa, the bar's axial stress.
  await expect(summary).toHaveText("1,000,000 N over 10,000 mm² → 100 MPa");

  // The value: half the force, half the traction.
  const form = page.getByTestId("load-edit-form");
  await form.locator("input").nth(0).fill("500000");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(summary).toHaveText("500,000 N over 10,000 mm² → 50 MPa");

  // The selection: add the y = 100 side, 1000 × 100 mm.
  await page.getByTitle("Add face").click();
  await lookFrom(page, [0.3, 1, 0.3]);
  await clickModelAt(page, [500, 100, 50]);
  await page.getByRole("button", { name: "Add Face", exact: true }).click();
  await expect(summary).toHaveText("500,000 N over 110,000 mm² → 4.55 MPa");

  // A pressure says the total force it pushes with.
  await page.getByTitle("Edit load").click();
  await form.locator("select").selectOption("pressure");
  await form.locator("input").fill("2");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(summary).toHaveText("2 MPa × 110,000 mm² → 220,000 N");
  await expect(page.getByTestId("group-summary-warning")).toHaveCount(0);
});

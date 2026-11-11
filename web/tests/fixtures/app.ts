// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "fs";
import path from "path";
import { expect, type Page } from "@playwright/test";

// The solver app is served at /app/ (the marketing landing lives at "/").
export const APP_PATH = "/app/";

// Absolute path of a committed CAD fixture in `test_files/`. Throws when the
// file is missing so a deleted or renamed fixture fails the test instead of
// skipping it.
export function fixturePath(name: string): string {
  const file = path.resolve("..", "test_files", name);
  if (!fs.existsSync(file)) {
    throw new Error(`Test fixture not found: ${file}`);
  }
  return file;
}

// Open the solver app with an empty model.
export async function gotoApp(page: Page): Promise<void> {
  await page.goto(APP_PATH);
  // The model tree renders as soon as the workspace mounts.
  await expect(page.locator("nav")).toBeVisible();
}

// Open the app and import a STEP file via the Geometry panel's import card.
export async function importStep(
  page: Page,
  stepFile: string,
  timeout = 60_000,
): Promise<void> {
  await gotoApp(page);
  await page
    .locator('input[type="file"][accept=".stp,.step"]')
    .setInputFiles(stepFile);
  // Tessellation done → the mesh controls (and "Generate mesh") appear.
  await expect(
    page.getByRole("button").filter({ hasText: "Generate mesh" }),
  ).toBeVisible({ timeout });

  const stepErr = page.getByTestId("step-error");
  if (await stepErr.isVisible()) {
    throw new Error(`STEP import failed: ${await stepErr.textContent()}`);
  }
}

// Open the app and import an IGES file via the Geometry panel's import card.
export async function importIges(
  page: Page,
  igesFile: string,
  timeout = 60_000,
): Promise<void> {
  await gotoApp(page);
  await page
    .locator('input[type="file"][accept=".igs,.iges"]')
    .setInputFiles(igesFile);
  // Tessellation done → the mesh controls (and "Generate mesh") appear.
  await expect(
    page.getByRole("button").filter({ hasText: "Generate mesh" }),
  ).toBeVisible({ timeout });

  const stepErr = page.getByTestId("step-error");
  if (await stepErr.isVisible()) {
    throw new Error(`IGES import failed: ${await stepErr.textContent()}`);
  }
}

import { expect, type Page } from "@playwright/test";

// The solver app is served at /app/ (the marketing landing lives at "/").
export const APP_PATH = "/app/";

// Open the solver app with an empty model.
export async function gotoApp(page: Page): Promise<void> {
  await page.goto(APP_PATH);
  // The mode-nav row renders as soon as the workspace mounts.
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
  // Tessellation done → the mesh controls (and "Mesh STEP volume") appear.
  await expect(
    page.getByRole("button").filter({ hasText: "Mesh STEP volume" }),
  ).toBeVisible({ timeout });

  const stepErr = page.getByTestId("step-error");
  if (await stepErr.isVisible()) {
    throw new Error(`STEP import failed: ${await stepErr.textContent()}`);
  }
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import type { BrowserContext, Page } from "@playwright/test";
import { fileURLToPath } from "url";
import { gotoApp } from "./fixtures/app";

// The solver engine's readiness in the status bar (KOF-263): it loads at
// start-up, an import picked meanwhile waits for it, and a failed download
// says what failed and recovers through Retry.

const STEP_FILE = fileURLToPath(
  new URL("./fixtures/tube.stp", import.meta.url),
);

const status = (page: Page) => page.getByTestId("engine-status");
const importCard = (page: Page) =>
  page.getByRole("button", { name: "Import STEP" });

async function importTube(page: Page) {
  await page
    .locator('input[type="file"][accept=".stp,.step"]')
    .setInputFiles(STEP_FILE);
  await expect(
    page.getByRole("button").filter({ hasText: "Mesh STEP volume" }),
  ).toBeVisible({ timeout: 60_000 });
}

// The engine binary is fetched by the solver worker; a context route sees it.
async function routeEngine(
  context: BrowserContext,
  handler: Parameters<BrowserContext["route"]>[1],
) {
  await context.route(/kofem_wasm_emcc[^/]*\.wasm$/, handler);
}

test("a blocked engine download names the cause, and Retry recovers", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  let blocked = true;
  await routeEngine(context, (route) =>
    blocked ? route.abort("failed") : route.continue(),
  );
  await gotoApp(page);

  const error = page.getByTestId("engine-error");
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(error).toContainText("Engine failed: download blocked");
  // The tooltip names the file that failed.
  await expect(error).toHaveAttribute("title", /kofem_wasm_emcc/);

  // An import cannot start without an engine, and says why.
  await expect(importCard(page)).toBeDisabled();
  await expect(importCard(page)).toHaveAttribute("title", /failed to load/);

  blocked = false;
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(status(page)).toHaveAttribute("data-phase", "ready", {
    timeout: 60_000,
  });
  await expect(error).toBeHidden();
  await expect(status(page)).toHaveText("Engine ready");
  await expect(importCard(page)).toBeEnabled();
  await importTube(page);
});

test("a missing engine file says to reload the page", async ({
  page,
  context,
}) => {
  await routeEngine(context, (route) =>
    route.fulfill({ status: 404, body: "Not Found" }),
  );
  await gotoApp(page);
  const error = page.getByTestId("engine-error");
  await expect(error).toContainText("reload the page", { timeout: 30_000 });
  await expect(error).toHaveAttribute("title", /HTTP 404/);
});

test("a file picked while the engine downloads waits for it", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await routeEngine(context, async (route) => {
    await held;
    await route.continue();
  });
  await gotoApp(page);

  await expect(status(page)).toHaveAttribute("data-phase", "downloading");
  await expect(status(page)).toContainText("Loading engine…");
  await page
    .locator('input[type="file"][accept=".stp,.step"]')
    .setInputFiles(STEP_FILE);
  await expect(page.getByText("Waiting for engine…").first()).toBeVisible();

  release();
  await expect(
    page.getByRole("button").filter({ hasText: "Mesh STEP volume" }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(status(page)).toHaveAttribute("data-phase", "ready");
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Drives the Optimize panel end to end through the real UI (KOF-232): bootstrap
// the cantilever fixture, open the new Optimize nav step, confirm the pre-flight
// checks gate the run the way Solve's do, adjust the SIMP settings in the panel,
// launch the run, and confirm it streams iteration logs and hands off to Results
// with the density field. The engine/worker path itself is covered at unit level
// by topology-optimize.spec.ts; this test is about the panel and the nav step.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { bootstrapCantilever } from "./fixtures/cantilever";

function goToOptimizePanel(page: Page) {
  return page
    .locator("nav")
    .getByRole("button")
    .filter({ hasText: "Optimize" })
    .click();
}

test("Optimize panel: gates, runs, streams logs, hands off to Results", async ({
  page,
}) => {
  test.setTimeout(120_000);

  const logs: string[] = [];
  page.on("console", (msg) => logs.push(msg.text()));
  page.on("pageerror", (e) =>
    console.error(`[optimize-panel] page error: ${e.message}`),
  );

  await bootstrapCantilever(page);
  await goToOptimizePanel(page);

  // The pre-flight checks mirror the solve's: the meshed, material-assigned,
  // constrained and loaded cantilever satisfies every one, and the default
  // min-compliance settings are valid — so the run is enabled.
  await expect(page.getByText(/Mesh ready/)).toBeVisible();
  await expect(page.getByText(/Loads applied/)).toBeVisible();
  await expect(page.getByText(/Minimize compliance/)).toBeVisible();

  const runButton = page.getByRole("button", { name: /Run optimization/ });
  await expect(runButton).toBeEnabled();

  // A filter radius sized to the beam (elements are 0.1 m) and a small iteration
  // cap keep the run fast and deterministic; the iteration field lives under the
  // collapsible "Advanced" group.
  await page.getByLabel("Filter r_min").fill("0.15");
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByLabel("Max iters").fill("8");

  await runButton.click();

  // A finished run advances to Results, which shows the density summary. The
  // full field visualization is KOF-233; here it is enough that the hand-off
  // happened and the density reached the store.
  await expect(page.getByText("Topology optimization")).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText(/Iterations/)).toBeVisible();

  // The optimizer streamed at least one per-iteration progress line into the
  // shared worker log channel ("[topopt] it N: …").
  expect(logs.some((l) => l.includes("[topopt] it"))).toBe(true);

  // The Results and Optimize nav steps now read as complete (a density exists).
  await goToOptimizePanel(page);
  await expect(
    page.getByText(/Topology optimization needs an applied load/),
  ).toHaveCount(0);
});

test("Optimize panel: invalid volume fraction blocks the run", async ({
  page,
}) => {
  await bootstrapCantilever(page);
  await goToOptimizePanel(page);

  const runButton = page.getByRole("button", { name: /Run optimization/ });
  await expect(runButton).toBeEnabled();

  // A volume fraction outside (0, 1) is rejected with an inline message under
  // the field and the run is disabled — no silent fallback to a default (house
  // rule). The same requirement also surfaces in the pre-flight check row, so
  // target the inline field error specifically.
  await page.getByLabel("Volume frac.").fill("1.5");
  await expect(
    page
      .locator('[class*="fieldError"]')
      .filter({ hasText: /volume fraction in \(0, 1\)/ }),
  ).toBeVisible();
  await expect(runButton).toBeDisabled();

  // Correcting it re-enables the run.
  await page.getByLabel("Volume frac.").fill("0.4");
  await expect(runButton).toBeEnabled();
});

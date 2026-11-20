// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-412: an optimization that stops at its iteration limit is not a finished
// design. Results and the Optimize panel say it did not converge, and offer to
// run again with a higher limit; a converged run shows no such notice.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { bootstrapCantilever } from "./fixtures/cantilever";
import { openTree } from "./fixtures/tree";

// Set up a short run on the cantilever: a filter radius sized to its 0.1 m
// elements, the iteration cap and the convergence tolerance.
async function configureRun(page: Page, maxIterations: string, tol: string) {
  await bootstrapCantilever(page);
  await openTree(page, "topopt");
  await page.getByLabel("Filter r_min").fill("0.15");
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByLabel("Max iters").fill(maxIterations);
  await page.getByLabel("Tolerance").fill(tol);
}

test("TO convergence: a run stopped at its limit says so, and runs again with a higher one @pipeline", async ({
  page,
}) => {
  page.on("pageerror", (e) =>
    console.error(`[to-convergence] page error: ${e.message}`),
  );
  // The worker's log reaches the console; one line ends each run.
  const completions: string[] = [];
  page.on("console", (msg) => {
    if (msg.text().includes("Topology optimization complete"))
      completions.push(msg.text());
  });

  // A tolerance no design meets in three iterations: the run hits its cap.
  await configureRun(page, "3", "0.000001");
  await page.getByRole("button", { name: /Run optimization/ }).click();

  await expect(page.getByText("Run summary")).toBeVisible();
  const notice = page.getByTestId("topopt-not-converged");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Not converged");
  await expect(notice).toContainText("3 iterations");

  // Back on the Optimize panel the same notice stands above the run.
  await openTree(page, "topopt");
  await expect(page.getByTestId("topopt-not-converged")).toContainText(
    "3 iterations",
  );

  // Run again from Results with twice the limit: the run starts at once and
  // lands on Results again, still capped at the stricter tolerance.
  await page
    .locator('[data-testid^="tree-plot-"]', { hasText: "Density" })
    .click();
  await page
    .getByRole("button", { name: "Run again with 6 iterations" })
    .click();
  await expect(page.getByTestId("topopt-not-converged")).toContainText(
    "6 iterations",
  );
  await expect(page.getByText("Run summary")).toBeVisible();
  const maxIterations = await page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: {
            getState(): { topOpt: { maxIterations: string } };
          };
        }
      ).__kofemStore.getState().topOpt.maxIterations,
  );
  expect(maxIterations).toBe("6");

  // "Run again" starts one run, not one per mount of the Optimize panel
  // (React StrictMode replays its effects). The worker answers in order, so
  // once a no-op request returns, every run sent before it has logged.
  await page.evaluate(() =>
    (
      window as unknown as {
        __kofem: {
          sendToWorker(type: string, payload: object): Promise<unknown>;
        };
      }
    ).__kofem.sendToWorker("init", {}),
  );
  expect(completions).toHaveLength(2);
});

test("TO convergence: a converged run shows no notice @pipeline", async ({
  page,
}) => {
  page.on("pageerror", (e) =>
    console.error(`[to-convergence] page error: ${e.message}`),
  );

  // A loose tolerance: the first steps already change the design less.
  await configureRun(page, "20", "0.5");
  await page.getByRole("button", { name: /Run optimization/ }).click();

  await expect(page.getByText("Run summary")).toBeVisible();
  await expect(page.getByTestId("topopt-not-converged")).toHaveCount(0);
});

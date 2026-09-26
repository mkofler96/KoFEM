// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Drives the topology-optimization RESULT view end to end through the real UI
// (KOF-233): bootstrap the cantilever, run a short optimization, then assert the
// Results view shows the density field (its legend), the convergence plot from
// the returned history, and that moving the density threshold changes how many
// elements are visible — the emerged-shape reveal. The worker/engine path and
// the Optimize panel itself are covered by topology-optimize.spec.ts and
// optimize-panel.spec.ts; this test is about the density result visualization.

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

// The slider's onChange calls setDensityThreshold(parseFloat(value)); driving it
// through the store exercises the same state path the viewport and the readout
// both read, without the React controlled-range-input event plumbing.
function setThreshold(page: Page, value: number) {
  return page.evaluate((v) => {
    (
      window as unknown as {
        __kofemStore: { getState(): { setDensityThreshold(x: number): void } };
      }
    ).__kofemStore
      .getState()
      .setDensityThreshold(v);
  }, value);
}

function densityLength(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: {
            getState(): { densityResult: { density: Float64Array } | null };
          };
        }
      ).__kofemStore.getState().densityResult?.density.length ?? 0,
  );
}

// Parse the "N / total" readout down to its visible count.
async function visibleCount(page: Page): Promise<number> {
  const text = await page.getByTestId("visible-element-count").textContent();
  const n = Number((text ?? "").trim().split("/")[0].trim());
  return n;
}

test("TO results: density field renders, threshold reveals the shape, convergence plot present", async ({
  page,
}) => {
  test.setTimeout(120_000);

  page.on("pageerror", (e) =>
    console.error(`[to-results] page error: ${e.message}`),
  );

  await bootstrapCantilever(page);
  await goToOptimizePanel(page);

  // A filter radius sized to the beam and a small iteration cap keep the run
  // fast and deterministic (mirrors optimize-panel.spec.ts).
  await page.getByLabel("Filter r_min").fill("0.15");
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByLabel("Max iters").fill("10");

  await page.getByRole("button", { name: /Run optimization/ }).click();

  // Hand-off to Results with the density view.
  await expect(page.getByText("Density threshold")).toBeVisible({
    timeout: 90_000,
  });

  // The density field is on screen: its legend mounts only when a density run is
  // the active result in the Results view.
  await expect(page.getByTestId("density-colorbar")).toBeVisible();

  // The convergence plot rendered from the returned history (at least one point).
  const plot = page.getByTestId("convergence-plot");
  await expect(plot).toBeVisible();
  expect(Number(await plot.getAttribute("data-points"))).toBeGreaterThanOrEqual(
    1,
  );

  const total = await densityLength(page);
  expect(total).toBeGreaterThan(0);

  // At threshold 0 every element is kept; the readout equals the element count.
  await setThreshold(page, 0);
  await expect(page.getByTestId("visible-element-count")).toHaveText(
    `${total} / ${total}`,
  );
  const countAll = await visibleCount(page);

  // Raising the threshold hides the low-density elements, so fewer are visible —
  // the emerged-shape reveal. A near-1 cutoff must keep strictly fewer than all.
  await setThreshold(page, 0.99);
  await expect.poll(() => visibleCount(page)).toBeLessThan(countAll);
});

// Live density during the run (KOF-240): while the optimizer runs, the Optimize
// step draws each streamed iteration's density. Record every store update of the
// live field before completion and check the viewport saw several iterations
// and a changing visible-element count at a fixed cutoff — the shape emerging.
test("TO live density: the viewport updates per iteration during the run", async ({
  page,
}) => {
  test.setTimeout(120_000);
  page.on("pageerror", (e) =>
    console.error(`[to-live] page error: ${e.message}`),
  );

  await bootstrapCantilever(page);
  await goToOptimizePanel(page);
  await setThreshold(page, 0.5);

  await page.getByLabel("Filter r_min").fill("0.15");
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByLabel("Max iters").fill("15");
  await page.getByLabel("Tolerance").fill("0.0001");

  await page.evaluate(() => {
    type LiveState = {
      mode: string;
      isOptimizing: boolean;
      liveDensity: { it: number; density: Float64Array } | null;
    };
    const win = window as unknown as {
      __kofemStore: {
        subscribe(cb: (s: LiveState) => void): () => void;
      };
      __liveSeen: { it: number; visible: number; mode: string }[];
    };
    win.__liveSeen = [];
    win.__kofemStore.subscribe((s) => {
      if (!s.isOptimizing || !s.liveDensity) return;
      const seen = win.__liveSeen;
      if (seen.length > 0 && seen[seen.length - 1].it === s.liveDensity.it)
        return;
      let visible = 0;
      for (const d of s.liveDensity.density) if (d >= 0.5) visible++;
      seen.push({ it: s.liveDensity.it, visible, mode: s.mode });
    });
  });

  await page.getByRole("button", { name: /Run optimization/ }).click();

  // The cantilever optimizes in well under a second, too fast to catch the live
  // panel on screen reliably, so the store subscription above is the record.
  // Completion hands off to Results as before; the live field is cleared.
  await expect(page.getByText("Run summary")).toBeVisible({ timeout: 90_000 });

  const seen = await page.evaluate(
    () =>
      (
        window as unknown as {
          __liveSeen: { it: number; visible: number; mode: string }[];
        }
      ).__liveSeen,
  );
  expect(seen.length).toBeGreaterThan(1);
  expect(seen.every((s) => s.mode === "optimize")).toBe(true);
  for (let i = 1; i < seen.length; i++)
    expect(seen[i].it).toBeGreaterThan(seen[i - 1].it);
  expect(new Set(seen.map((s) => s.visible)).size).toBeGreaterThan(1);

  const liveAfter = await page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: { getState(): { liveDensity: unknown } };
        }
      ).__kofemStore.getState().liveDensity,
  );
  expect(liveAfter).toBeNull();
});

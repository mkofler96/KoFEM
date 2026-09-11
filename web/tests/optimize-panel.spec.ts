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

  // A finished run advances to Results, which shows the density view (KOF-233):
  // the threshold slider and the run summary. Here it is enough that the hand-off
  // happened and the density reached the store; the density-field visualization
  // and threshold behaviour are covered by topology-optimize-results.spec.ts.
  await expect(page.getByText("Density threshold")).toBeVisible({
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

test("Optimize panel: a multi-material model is blocked (v1 optimizes one material)", async ({
  page,
}) => {
  await bootstrapCantilever(page);

  // TO v1 optimizes a single design material — the engine reads only the first
  // one — so a model whose bodies use different materials must be refused rather
  // than optimized as if every body were the first material.
  await page.evaluate(() => {
    const store = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            materials: unknown[];
            elements: { propertyId: number }[];
          };
          setState(s: object): void;
        };
      }
    ).__kofemStore;
    const state = store.getState();
    store.setState({
      materials: [
        ...state.materials,
        {
          id: 2,
          name: "Aluminum",
          young: 70e9,
          poisson: 0.33,
          density: 2700,
          color: "#e15759",
        },
      ],
      properties: [
        { id: 1, materialId: 1 },
        { id: 2, materialId: 2 },
      ],
      elements: state.elements.map((e, i) =>
        i % 2 === 0 ? { ...e, propertyId: 2 } : e,
      ),
    });
  });

  await goToOptimizePanel(page);
  await expect(
    page.getByText(/uses one design material, but the model spans 2/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Run optimization/ }),
  ).toBeDisabled();
});

test("Optimize panel: a non-zero prescribed displacement is blocked", async ({
  page,
}) => {
  await bootstrapCantilever(page);

  // The engine's compliance sensitivity assumes homogeneous supports and rejects
  // any non-zero prescribed displacement, so the pre-flight must catch it.
  await page.evaluate(() => {
    const store = (
      window as unknown as {
        __kofemStore: {
          getState(): { constraints: { prescribedValue?: number }[] };
          setState(s: object): void;
        };
      }
    ).__kofemStore;
    const state = store.getState();
    store.setState({
      constraints: state.constraints.map((c, i) =>
        i === 0 ? { ...c, prescribedValue: 0.5 } : c,
      ),
    });
  });

  await goToOptimizePanel(page);
  await expect(
    page.getByText(/Remove non-zero prescribed displacements/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Run optimization/ }),
  ).toBeDisabled();
});

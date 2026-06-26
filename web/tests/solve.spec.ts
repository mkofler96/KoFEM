// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import path from "path";
import fs from "fs";
import { bootstrapCantilever } from "./fixtures/cantilever";
import { gotoApp, importStep } from "./fixtures/app";

// Navigate to the "04 Solve" mode tab in the top navigation bar
async function goToSolvePanel(page: import("@playwright/test").Page) {
  await page
    .locator("nav")
    .getByRole("button")
    .filter({ hasText: "Solve" })
    .click();
}

// Returns a promise that rejects the moment any browser console.error or
// uncaught page exception fires. Race this against every critical await so
// the test fails immediately instead of waiting for a timeout.
function watchForErrors(
  page: import("@playwright/test").Page,
  tag: string,
): Promise<never> {
  let _reject: ((err: Error) => void) | null = null;
  const p = new Promise<never>((_, rej) => {
    _reject = rej;
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      console.error(`[${tag}] browser error: ${text}`);
      _reject?.(new Error(`Browser console.error: ${text}`));
    } else {
      console.log(`[${tag}] browser ${msg.type()}: ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    console.error(`[${tag}] page exception: ${err.message}`);
    _reject?.(err);
  });
  return p;
}

test("app loads with import and load options", async ({ page }) => {
  const fatal = watchForErrors(page, "load");

  await gotoApp(page);

  // The Geometry panel offers STEP import; the top bar offers loading a .vtu.
  await Promise.race([
    expect(page.getByRole("button", { name: "Import STEP" })).toBeVisible(),
    fatal,
  ]);
  await Promise.race([
    expect(page.getByRole("button", { name: "Load analysis" })).toBeVisible(),
    fatal,
  ]);
});

// ── Solver integration tests ──────────────────────────────────────────────────

// Regression test for #157: the Results-panel field selector must reach the
// von Mises view. The cantilever fixture is solved via the worker and the
// result is pushed into the store, so this exercises the Results UI only —
// solver correctness itself is covered by cantilever-solve.spec.ts.
test("results panel switches to von Mises stress", async ({ page }) => {
  const fatal = watchForErrors(page, "results-ui");

  await bootstrapCantilever(page);

  await page.evaluate(async () => {
    const store = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            nodes: unknown[];
            elements: unknown[];
            materials: unknown[];
            properties: unknown[];
            constraints: unknown[];
            loads: unknown[];
            surfaceLoads: unknown[];
            setResult(r: {
              displacements: Float64Array;
              vonMises?: Float64Array;
            }): void;
            setMode(m: string): void;
          };
        };
      }
    ).__kofemStore;
    const s = store.getState();
    const { displacements, vonMises } = (await (
      window as unknown as {
        __kofem: {
          sendToWorker(name: string, payload: object): Promise<unknown>;
        };
      }
    ).__kofem.sendToWorker("solve", {
      nodes: s.nodes,
      elements: s.elements,
      materials: s.materials,
      properties: s.properties,
      constraints: s.constraints,
      loads: s.loads,
      surfaceLoads: s.surfaceLoads,
    })) as { displacements: number[]; vonMises: number[] };
    store.getState().setResult({
      displacements: new Float64Array(displacements),
      vonMises: vonMises ? new Float64Array(vonMises) : undefined,
    });
    store.getState().setMode("results");
  });

  await Promise.race([
    expect(page.getByText(/Max \|U\|/)).toBeVisible({ timeout: 30_000 }),
    fatal,
  ]);

  const fieldSelect = page.locator("select", {
    has: page.locator('option[value="Von Mises stress"]'),
  });
  await fieldSelect.selectOption("Von Mises stress");
  await Promise.race([expect(page.getByText(/Max σ_vm/)).toBeVisible(), fatal]);
});

// ── STEP → Volume mesh pipeline ───────────────────────────────────────────────
// Wall Bracket solve regression (WASM trap / SetIntPoint DCE) is covered by
// the Node.js script test_wall_bracket.mjs, which runs synchronously with no
// browser async layer and surfaces raw WASM errors directly.

const STEP_FILE = path.resolve("..", "test_files", "tube.stp");

test("vol mesh stores FEM nodes in the store for solving", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!fs.existsSync(STEP_FILE), `STEP fixture not found: ${STEP_FILE}`);

  const t0 = Date.now();
  const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  const fatal = watchForErrors(page, "vol-mesh");

  // ── 1. Enter the app by importing (tessellating) the STEP file ────────────
  await importStep(page, STEP_FILE);
  console.log(`[vol-mesh] ${elapsed()} STEP tessellation done`);

  // ── 2. Compute volume mesh (controls live in the Geometry panel) ──────────
  await page
    .getByRole("button")
    .filter({ hasText: "Mesh STEP volume" })
    .click();
  console.log(`[vol-mesh] ${elapsed()} clicked Mesh STEP volume`);

  // "Meshing…" is a transient label that can vanish before Playwright polls for
  // it when the WASM worker completes very quickly.  Wait for the stable
  // post-mesh state instead: "Mesh is solver-ready" only appears once the store
  // has nodes (nodes.length > 0), regardless of how fast meshing ran.
  await Promise.race([
    expect(page.getByText("Mesh is solver-ready")).toBeVisible({
      timeout: 150_000,
    }),
    fatal,
  ]);
  console.log(`[vol-mesh] ${elapsed()} meshing finished`);

  const meshErr = page.locator('[class*="errorBanner"]');
  if (await meshErr.isVisible()) {
    throw new Error(`mesh error banner: ${await meshErr.textContent()}`);
  }

  // ── 4. Verify FEM data landed in the store ────────────────────────────────
  await goToSolvePanel(page);
  console.log(`[vol-mesh] ${elapsed()} navigated to Solve panel`);

  await Promise.race([
    expect(page.getByText(/Mesh ready/)).toBeVisible({ timeout: 10_000 }),
    fatal,
  ]);
  console.log(`[vol-mesh] ${elapsed()} Mesh ready visible — PASS`);
});

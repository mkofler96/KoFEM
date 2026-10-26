// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "fs";
import os from "os";
import path from "path";
import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";

// The first simulation a newcomer runs (KOF-261): the empty workspace offers
// the cantilever sample, which opens ready to run, solves with one click and
// puts its result next to the hand calculation −P·L³ / (3·E·I).

type Page = import("@playwright/test").Page;

function readModel(page: Page) {
  return page.evaluate(() => {
    const st = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            modelName: string;
            mode: string;
            result: unknown;
            elementOrder: number;
            handCheck: unknown;
          };
        };
      }
    ).__kofemStore.getState();
    return {
      modelName: st.modelName,
      mode: st.mode,
      hasResult: st.result !== null,
      elementOrder: st.elementOrder,
      hasHandCheck: st.handCheck !== null,
    };
  });
}

// "−1.904 mm" → -1.904
async function millimetres(page: Page, testId: string): Promise<number> {
  const text = await page.getByTestId(testId).innerText();
  const value = Number(text.replace(/\s*mm$/, "").replace("−", "-"));
  if (!Number.isFinite(value))
    throw new Error(`${testId} shows "${text}", not a length in mm`);
  return value;
}

test("a newcomer runs the sample from the empty workspace and reads the hand check", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await gotoApp(page);
  const start = Date.now();
  let clicks = 0;

  // Nothing loaded: the viewport offers the sample.
  const emptyState = page.getByTestId("empty-state");
  await expect(emptyState).toBeVisible();

  // One click opens it on its static study, ready to run.
  await page.getByRole("button", { name: "Try a sample simulation" }).click();
  clicks++;
  await expect(emptyState).toBeHidden();
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled({ timeout: 15_000 });
  expect(await readModel(page)).toEqual({
    modelName: "Cantilever beam under tip load",
    mode: "solve",
    hasResult: false,
    elementOrder: 2,
    hasHandCheck: true,
  });

  // One more click solves it, and the result comes with its hand check.
  await run.click();
  clicks++;
  const check = page.getByTestId("hand-check");
  await expect(check).toBeVisible({ timeout: 90_000 });
  await expect(check).toContainText("−P·L³ / (3·E·I)");
  const fe = await millimetres(page, "hand-check-fe");
  const reference = await millimetres(page, "hand-check-reference");
  expect(reference).toBeCloseTo(-1.905, 3);
  // Quadratic tets on the 25 mm mesh match Euler–Bernoulli to well under 1 %.
  expect(Math.abs(fe / reference - 1)).toBeLessThan(0.01);

  // The issue's target is a human under two minutes; the scripted path, with
  // the solve, has to be far inside it.
  const seconds = (Date.now() - start) / 1000;
  console.log(`[first-simulation] ${clicks} clicks, ${seconds.toFixed(1)} s`);
  expect(clicks).toBe(2);
  expect(seconds).toBeLessThan(120);
});

test("the hand check is withheld once the load no longer matches it", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto("/app/?example=cantilever-beam");
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled({ timeout: 15_000 });
  await run.click();
  await expect(page.getByTestId("hand-check-fe")).toBeVisible({
    timeout: 90_000,
  });

  // Twice the load, solved again: the formula's 10 kN no longer describes the
  // model.
  await page.evaluate(() =>
    (
      window as unknown as {
        __kofemStore: {
          getState(): {
            updateLoadGroup(
              id: number,
              kind: "force",
              totalForce: number,
              components: [number, number, number],
            ): void;
          };
        };
      }
    ).__kofemStore
      .getState()
      .updateLoadGroup(1, "force", -20000, [0, -20000, 0]),
  );
  await page.getByTestId("tree-study-1").click();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("hand-check")).toContainText(
    "no longer applies",
    { timeout: 90_000 },
  );
  await expect(page.getByTestId("hand-check-fe")).toHaveCount(0);
});

test("a saved sample keeps its element order and hand check", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kofem-sample-"));

  await page.goto("/app/?example=cantilever-beam");
  await expect(
    page.getByRole("button", { name: /Run static solve/ }),
  ).toBeEnabled({ timeout: 15_000 });

  const file = path.join(tmpDir, "sample.vtu");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save analysis" }).click();
  await (await download).saveAs(file);

  // Reopened in a fresh session: still quadratic, still checked.
  await gotoApp(page);
  await page.locator('input[type="file"][accept=".vtu"]').setInputFiles(file);
  await expect
    .poll(async () => (await readModel(page)).modelName, { timeout: 15_000 })
    .toBe("Cantilever beam under tip load");
  const model = await readModel(page);
  expect(model.elementOrder).toBe(2);
  expect(model.hasHandCheck).toBe(true);
});

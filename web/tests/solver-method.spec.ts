// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Solve panel's solver choice: AMG multigrid is preselected and marked
// recommended, it solves linear-tet models through the Rust module, it says so
// when a model is outside its reach, and Gauss–Seidel gives the same field.

import type { Page } from "@playwright/test";
import { test, expect } from "./coverage";

interface StoreWindow {
  __kofemStore: {
    getState(): {
      stepBytes: Uint8Array | null;
      result: { displacements: Float64Array } | null;
      isRunning: boolean;
      setElementOrder(order: number): void;
      setMode(mode: "solve"): void;
    };
  };
}

async function openCantilever(page: Page) {
  await page.goto("/app/?example=cantilever-beam");
  await page.waitForFunction(
    () =>
      (window as unknown as StoreWindow).__kofemStore.getState().stepBytes !==
      null,
    null,
    { timeout: 15_000 },
  );
}

async function solveAndRead(page: Page): Promise<number[]> {
  await page.getByRole("button", { name: /Run static solve/ }).click();
  await page.waitForFunction(
    () => {
      const st = (window as unknown as StoreWindow).__kofemStore.getState();
      return !st.isRunning && st.result !== null;
    },
    null,
    { timeout: 60_000 },
  );
  return page.evaluate(() =>
    Array.from(
      (window as unknown as StoreWindow).__kofemStore.getState().result
        ?.displacements ?? [],
    ),
  );
}

async function backToSolve(page: Page) {
  await page.evaluate(() =>
    (window as unknown as StoreWindow).__kofemStore.getState().setMode("solve"),
  );
}

test("AMG is the recommended default and matches Gauss–Seidel", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openCantilever(page);

  const select = page.getByTestId("solver-method");
  await expect(select).toHaveValue("amg");
  await expect(select.locator("option:checked")).toHaveText(
    "AMG multigrid (recommended)",
  );

  // The example opens with quadratic elements, which AMG does not cover: the
  // panel says so before the solve.
  await expect(page.getByTestId("solver-method-note")).toContainText(
    "linear elements only",
  );

  // Linear elements: AMG applies, and the solve runs through it.
  await page.evaluate(() =>
    (window as unknown as StoreWindow).__kofemStore
      .getState()
      .setElementOrder(1),
  );
  await expect(page.getByTestId("solver-method-note")).toHaveCount(0);
  const multigrid = await solveAndRead(page);
  // The solve log survives the switch to Results; go back and read it.
  await backToSolve(page);
  await expect(page.getByText(/AMG CG converged/)).toBeVisible();

  // The same model with Gauss–Seidel gives the same displacements.
  await page.getByTestId("solver-method").selectOption("gauss-seidel");
  const gaussSeidel = await solveAndRead(page);
  await backToSolve(page);
  await expect(page.getByText(/\[mfem\] CG converged/)).toBeVisible();
  await expect(page.getByText(/AMG CG converged/)).toHaveCount(0);

  expect(multigrid.length).toBe(gaussSeidel.length);
  const peak = Math.max(...gaussSeidel.map(Math.abs));
  const difference = Math.max(
    ...gaussSeidel.map((value, i) => Math.abs(value - multigrid[i])),
  );
  expect(peak).toBeGreaterThan(0);
  expect(difference / peak).toBeLessThan(1e-5);
});

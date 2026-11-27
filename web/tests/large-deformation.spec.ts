// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Solve panel's Large deformation option (KOF-486): off by default; on,
// it asks for the load increments and solves the solid model with
// Neo-Hookean solids, which under the cantilever example's small load agrees
// with the linear solve. A model the large-deformation solve does not take
// (a body solved as a shell) is refused before the run, and so is a topology
// optimization while the option is on.

import type { Page } from "@playwright/test";
import { test, expect } from "./coverage";
import { openTree } from "./fixtures/tree";
import {
  largeDeformationRefusal,
  topOptLargeDeformationRefusal,
} from "../src/lib/solve/refusals";

interface StoreWindow {
  __kofemStore: {
    getState(): {
      stepBytes: Uint8Array | null;
      isRunning: boolean;
      result: {
        displacements: Float64Array;
        run?: { largeDeformation: { increments: number } | null };
      } | null;
      loadIncrements: number;
      properties: { id: number }[];
      setBodyDiscretization(propertyId: number, disc: "solid" | "shell"): void;
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
  );
}

// Solve and return the displacements and the large deformation the run
// recorded.
async function solve(page: Page) {
  await page.getByRole("button", { name: /Run static solve/ }).click();
  await page.waitForFunction(() => {
    const st = (window as unknown as StoreWindow).__kofemStore.getState();
    return !st.isRunning && st.result !== null;
  }, null);
  return page.evaluate(() => {
    const { result } = (
      window as unknown as StoreWindow
    ).__kofemStore.getState();
    return {
      displacements: Array.from(result?.displacements ?? []),
      largeDeformation: result?.run?.largeDeformation,
    };
  });
}

// A refusal the model must have.
function required(refusal: string | null): string {
  if (refusal === null) throw new Error("expected a refusal");
  return refusal;
}

const largest = (values: number[]) =>
  values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

test("Large deformation solves the cantilever and agrees with the linear solve under its small load", async ({
  page,
}) => {
  await openCantilever(page);
  const toggle = page.getByTestId("large-deformation");
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId("load-increments")).toHaveCount(0);

  const linear = await solve(page);
  expect(linear.largeDeformation).toBeNull();

  await page.evaluate(() =>
    (window as unknown as StoreWindow).__kofemStore.getState().setMode("solve"),
  );
  await toggle.check();
  const increments = page.getByTestId("load-increments");
  await expect(increments).toHaveValue("10");
  await expect(page.getByTestId("large-deformation-note")).toContainText(
    "Neo-Hookean",
  );
  await increments.fill("0");
  await expect(page.getByTestId("large-deformation-note")).toHaveText(
    "Enter a whole number from 1 to 100.",
  );
  await increments.fill("2");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as StoreWindow).__kofemStore.getState()
            .loadIncrements,
      ),
    )
    .toBe(2);

  const nonlinear = await solve(page);
  expect(nonlinear.largeDeformation).toEqual({ increments: 2 });
  const tip = largest(linear.displacements);
  expect(tip).toBeGreaterThan(0);
  expect(Math.abs(largest(nonlinear.displacements) - tip) / tip).toBeLessThan(
    0.02,
  );
});

test("Large deformation is refused on a body solved as a shell and by the optimizer", async ({
  page,
}) => {
  await openCantilever(page);
  const runButton = page.getByRole("button", { name: /Run static solve/ });
  await page.getByTestId("large-deformation").check();
  await expect(runButton).toBeEnabled();

  // Shells are linear: at the example's order 2 the order would be refused
  // first.
  await page.evaluate(() => {
    const state = (window as unknown as StoreWindow).__kofemStore.getState();
    state.setElementOrder(1);
    state.setBodyDiscretization(state.properties[0].id, "shell");
  });
  await expect(
    page.getByTestId("check-fail").filter({ hasText: /Large deformation/ }),
  ).toHaveText(
    required(
      largeDeformationRefusal(
        { largeDeformation: { increments: 10 } },
        "auto-shell",
      ),
    ),
  );
  await expect(runButton).toBeDisabled();
  await page.evaluate(() => {
    const state = (window as unknown as StoreWindow).__kofemStore.getState();
    state.setBodyDiscretization(state.properties[0].id, "solid");
  });
  await expect(runButton).toBeEnabled();

  await openTree(page, "topopt");
  await expect(
    page.getByTestId("check-fail").filter({ hasText: /large deformation/ }),
  ).toHaveText(required(topOptLargeDeformationRefusal({ increments: 10 })));
});

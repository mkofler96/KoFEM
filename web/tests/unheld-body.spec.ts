// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-388: a support that leaves a body free to slide or spin is caught before
// the solve. The pre-flight check names the body and the free motion, the run
// button stays disabled, and a solve started anyway is refused with the same
// words instead of failing inside the solver.

import type { Page } from "@playwright/test";
import { test, expect } from "./coverage";
import { bootstrapCantilever } from "./fixtures/cantilever";
import { openTree } from "./fixtures/tree";

interface StoreWindow {
  __kofemStore: {
    getState(): {
      bcGroups: { id: number }[];
      updateBcGroup(id: number, dofs: number[], value: number): void;
    };
  };
  __kofemTriggerSolve: () => void;
}

// The cantilever's support clamps its x = 0 face; restrict it to `dofs`.
const supportDofs = (page: Page, dofs: number[]) =>
  page.evaluate((value) => {
    const state = (window as unknown as StoreWindow).__kofemStore.getState();
    state.updateBcGroup(state.bcGroups[0].id, value, 0);
  }, dofs);

// Fixed in Z only, the x = 0 face holds the beam against moving along Z and
// rotating about X, but not against sliding along X and Y, spinning about Z,
// or tilting about the Y axis through the face.
const LOOSE =
  "Body 1 can still move along X and Y, and rotate about Y and Z. " +
  "Add a support or connect it to another body.";

test("the Solve panel names the motion a support leaves free and refuses the solve", async ({
  page,
}) => {
  await bootstrapCantilever(page);
  await openTree(page, "static");
  const runButton = page.getByRole("button", { name: /Run static solve/ });
  const failedCheck = page.getByTestId("check-fail").filter({ hasText: LOOSE });

  await expect(runButton).toBeEnabled();
  await expect(failedCheck).toHaveCount(0);

  await supportDofs(page, [2]);
  await expect(failedCheck).toBeVisible();
  await expect(runButton).toBeDisabled();

  // Started anyway, the worker refuses it with the same words.
  await page.evaluate(() =>
    (window as unknown as StoreWindow).__kofemTriggerSolve(),
  );
  await expect(
    page.getByText(/^Solver error: /).filter({ hasText: LOOSE }),
  ).toBeVisible();

  await supportDofs(page, [0, 1, 2]);
  await expect(failedCheck).toHaveCount(0);
  await expect(runButton).toBeEnabled();
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import { bootstrapCantilever } from "./fixtures/cantilever";
import type { Page } from "@playwright/test";

// Coverage for issue #258: the ✎ button on a BC / load group must open an
// inline editor for the group's values (force components, pressure magnitude,
// constrained DOFs, prescribed displacement) — not just allow face changes.

type Store = {
  getState(): {
    bcGroups: { id: number; dofs: number[]; value: number }[];
    loadGroups: {
      id: number;
      kind?: string;
      dof: number;
      totalForce: number;
      components?: [number, number, number];
    }[];
    constraints: { nodeId: number; dof: number; prescribedValue?: number }[];
    surfaceLoads: {
      type: string;
      force?: [number, number, number];
      pressure?: number;
    }[];
    result: unknown;
    updateLoadGroup(
      id: number,
      kind: string,
      totalForce: number,
      components?: [number, number, number],
    ): void;
    setResult(r: { displacements: Float64Array }): void;
  };
  setState(s: object): void;
};

async function openConstraintsMode(page: Page): Promise<void> {
  await bootstrapCantilever(page);
  await page.evaluate(() => {
    (window as unknown as { __kofemStore: Store }).__kofemStore.setState({
      mode: "constraints",
    });
  });
}

test("editing a load group's force components updates the surface loads", async ({
  page,
}) => {
  await openConstraintsMode(page);

  await page.getByTitle("Edit load").click();
  const form = page.getByTestId("load-edit-form");
  await expect(form).toBeVisible();

  // The form opens pre-filled with the group's current vector (legacy
  // single-axis Fy = −10000 reconstructed componentwise).
  const inputs = form.locator("input");
  await expect(inputs.nth(0)).toHaveValue("0");
  await expect(inputs.nth(1)).toHaveValue("-10000");
  await expect(inputs.nth(2)).toHaveValue("0");

  await inputs.nth(0).fill("100");
  await inputs.nth(1).fill("-200");
  await inputs.nth(2).fill("300");
  await form.getByRole("button", { name: "Save" }).click();

  await expect(form).not.toBeVisible();
  const state = await page.evaluate(() => {
    const storeState = (
      window as unknown as { __kofemStore: Store }
    ).__kofemStore.getState();
    return {
      group: storeState.loadGroups[0],
      surfaceLoads: storeState.surfaceLoads,
    };
  });
  expect(state.group.components).toEqual([100, -200, 300]);
  expect(state.group.kind).toBe("force");
  expect(state.surfaceLoads.length).toBeGreaterThan(0);
  for (const sl of state.surfaceLoads) {
    expect(sl.type).toBe("force");
    expect(sl.force).toEqual([100, -200, 300]);
  }
});

test("editing a load group can switch its kind to pressure", async ({
  page,
}) => {
  await openConstraintsMode(page);

  await page.getByTitle("Edit load").click();
  const form = page.getByTestId("load-edit-form");
  await form.locator("select").selectOption("pressure");
  await form.locator("input").fill("25");
  await form.getByRole("button", { name: "Save" }).click();

  const state = await page.evaluate(() => {
    const storeState = (
      window as unknown as { __kofemStore: Store }
    ).__kofemStore.getState();
    return {
      group: storeState.loadGroups[0],
      surfaceLoads: storeState.surfaceLoads,
    };
  });
  expect(state.group.kind).toBe("pressure");
  expect(state.group.totalForce).toBe(25);
  // Switching to pressure drops the stale force vector.
  expect(state.group.components).toBeUndefined();
  for (const sl of state.surfaceLoads) {
    expect(sl.type).toBe("pressure");
    expect(sl.pressure).toBe(25);
  }
});

test("an all-zero force vector is rejected with an error", async ({ page }) => {
  await openConstraintsMode(page);

  await page.getByTitle("Edit load").click();
  const form = page.getByTestId("load-edit-form");
  const inputs = form.locator("input");
  await inputs.nth(1).fill("0");
  await form.getByRole("button", { name: "Save" }).click();

  await expect(page.getByTestId("load-edit-error")).toContainText(
    "non-zero force component",
  );
  // The group is untouched.
  const group = await page.evaluate(
    () =>
      (window as unknown as { __kofemStore: Store }).__kofemStore.getState()
        .loadGroups[0],
  );
  expect(group.totalForce).toBe(-10000);
});

test("editing a BC group's DOFs and value rebuilds the constraints", async ({
  page,
}) => {
  await openConstraintsMode(page);

  await page.getByTitle("Edit BC").click();
  const form = page.getByTestId("bc-edit-form");
  await expect(form).toBeVisible();

  // Pre-filled from the group: Ux, Uy, Uz all fixed at 0.
  const checks = form.locator("input[type=checkbox]");
  await expect(checks.nth(0)).toBeChecked();
  await expect(checks.nth(1)).toBeChecked();
  await expect(checks.nth(2)).toBeChecked();

  // Release Uz and prescribe Ux = Uy = 0.5.
  await checks.nth(2).uncheck();
  await form.locator("input[type=number]").fill("0.5");
  await form.getByRole("button", { name: "Save" }).click();

  await expect(form).not.toBeVisible();
  const state = await page.evaluate(() => {
    const storeState = (
      window as unknown as { __kofemStore: Store }
    ).__kofemStore.getState();
    return {
      group: storeState.bcGroups[0],
      constraints: storeState.constraints,
    };
  });
  expect(state.group.dofs).toEqual([0, 1]);
  expect(state.group.value).toBe(0.5);
  expect(state.constraints.every((c) => c.dof !== 2)).toBe(true);
  expect(state.constraints.every((c) => c.prescribedValue === 0.5)).toBe(true);
});

test("unchecking every DOF is rejected with an error", async ({ page }) => {
  await openConstraintsMode(page);

  await page.getByTitle("Edit BC").click();
  const form = page.getByTestId("bc-edit-form");
  const checks = form.locator("input[type=checkbox]");
  await checks.nth(0).uncheck();
  await checks.nth(1).uncheck();
  await checks.nth(2).uncheck();
  await form.getByRole("button", { name: "Save" }).click();

  await expect(page.getByTestId("bc-edit-error")).toContainText(
    "at least one DOF",
  );
});

test("updating load values invalidates a stale result", async ({ page }) => {
  await openConstraintsMode(page);

  const resultCleared = await page.evaluate(() => {
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;
    store.getState().setResult({ displacements: new Float64Array(3) });
    const id = store.getState().loadGroups[0].id;
    store.getState().updateLoadGroup(id, "force", 0, [0, -20000, 0]);
    return store.getState().result === null;
  });
  expect(resultCleared).toBe(true);
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Geometry → Body N → Suppressed: the body is taken out of the model as if it
// were deleted — not drawn, not meshed, not analysed — and comes back with one
// click.

import path from "path";
import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { importStep } from "./fixtures/app";
import { openBody, openTree } from "./fixtures/tree";

const TWO_BOXES = path.resolve("..", "test_files", "two_boxes.stp");

interface MeshState {
  nodes: unknown[];
  elements: { propertyId: number }[];
  properties: { id: number; suppressed?: boolean }[];
  fitViewTrigger: number;
}

const state = (page: Page) =>
  page.evaluate(() => {
    const store = (
      window as unknown as { __kofemStore: { getState(): MeshState } }
    ).__kofemStore.getState();
    return {
      nodes: store.nodes.length,
      bodies: [...new Set(store.elements.map((e) => e.propertyId))].sort(),
      suppressed: store.properties.filter((p) => p.suppressed).map((p) => p.id),
      generation: store.fitViewTrigger,
    };
  });

async function mesh(page: Page): Promise<void> {
  const before = (await state(page)).generation;
  await openTree(page, "mesh");
  await page
    .getByRole("button")
    .filter({ hasText: /(re-)?mesh STEP volume/i })
    .click();
  await expect
    .poll(async () => (await state(page)).generation, { timeout: 90_000 })
    .toBeGreaterThan(before);
}

test("a suppressed body is left out of the mesh and comes back when unsuppressed", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await importStep(page, TWO_BOXES);
  await mesh(page);
  const full = await state(page);
  expect(full.bodies).toEqual([1, 2]);

  await openBody(page, 2);
  await page.getByTestId("body-suppressed-2").check();
  await expect(page.getByTestId("tree-body-2")).toContainText("suppressed");
  // The mesh predates the suppression: say so, and refuse to solve on it.
  await expect(page.getByTestId("suppressed-remesh-note")).toBeVisible();
  await openTree(page, "static");
  await expect(
    page.getByText("Re-mesh: suppressed Body 2 still in the mesh"),
  ).toBeVisible();

  await mesh(page);
  const without = await state(page);
  expect(without.bodies).toEqual([1]);
  expect(without.nodes).toBeLessThan(full.nodes);
  expect(without.nodes).toBeGreaterThan(0);

  // One click brings it back, exactly as it was.
  await openBody(page, 2);
  await page.getByTestId("body-suppressed-2").uncheck();
  expect((await state(page)).suppressed).toEqual([]);
  await mesh(page);
  expect((await state(page)).bodies).toEqual([1, 2]);
});

test("the last body in the model cannot be suppressed", async ({ page }) => {
  await importStep(page, TWO_BOXES);
  await openBody(page, 1);
  await page.getByTestId("body-suppressed-1").check();
  await openBody(page, 2);
  await expect(page.getByTestId("body-suppressed-2")).toBeDisabled();
});

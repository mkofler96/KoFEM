// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The model tree picks the viewport representation by context: the geometry
// entries (bodies, Booleans, split, materials) show the CAD geometry, the mesh
// and everything after it show the mesh — in the mesh view last chosen.

import path from "path";
import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { importStep } from "./fixtures/app";
import { openBody, openTree } from "./fixtures/tree";

const TWO_BOXES = path.resolve("..", "test_files", "two_boxes.stp");

const viewRepr = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: { getState(): { viewRepr: string } };
        }
      ).__kofemStore.getState().viewRepr,
  );

const statusRepr = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).click();

test("switching between geometry and mesh entries switches the viewport", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await importStep(page, TWO_BOXES);
  await page.getByRole("button", { name: /mesh STEP volume/i }).click();
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __kofemStore: { getState(): { nodes: unknown[] } };
        }
      ).__kofemStore.getState().nodes.length > 0,
    null,
    { timeout: 90_000 },
  );
  expect(await viewRepr(page)).toBe("surface");

  // Back to the geometry: the mesh gives way to the CAD bodies.
  await openBody(page, 1);
  await expect.poll(() => viewRepr(page)).toBe("geometry");

  // Forward again: the mesh view chosen last comes back.
  await openTree(page, "mesh");
  await expect.poll(() => viewRepr(page)).toBe("surface");
  await statusRepr(page, "Volume");
  await page.getByTestId("tree-add-materials").click();
  await expect.poll(() => viewRepr(page)).toBe("geometry");
  await page.getByTestId("tree-add-boundary").click();
  await expect.poll(() => viewRepr(page)).toBe("volume");

  // Within one context the user's own pick stays.
  await statusRepr(page, "Wireframe");
  await openTree(page, "static");
  await expect.poll(() => viewRepr(page)).toBe("wireframe");
});

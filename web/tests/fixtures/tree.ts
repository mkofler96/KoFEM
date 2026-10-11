// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Page } from "@playwright/test";

// Model-tree navigation. The dividers (Geometry, Mesh, …) only collapse; the
// entries under them open their editor in the properties panel.

// A fixed entry: the split tool, the volume mesh, a study or the results.
export async function openTree(
  page: Page,
  view: "split" | "mesh" | "static" | "topopt" | "results",
): Promise<void> {
  await page.getByTestId(`tree-view-${view}`).click();
}

// Boundary conditions → + Add → <kind>. The creation pick starts right away.
export async function addBoundary(
  page: Page,
  kind: "bc" | "load" | "tie" | "coupling",
): Promise<void> {
  await page.getByTestId("tree-add-boundary").click();
  await page.getByTestId(`add-boundary-${kind}`).click();
}

// Materials → + Add: the new-material form.
export async function addMaterial(page: Page): Promise<void> {
  await page.getByTestId("tree-add-materials").click();
}

// Geometry → Body <id>: that body's visibility, material and element type.
export async function openBody(page: Page, id: number): Promise<void> {
  await page.getByTestId(`tree-body-${id}`).click();
  // Hovering a body entry highlights the body (others dim); leave the entry so
  // the viewport shows the model as it is.
  await page.mouse.move(0, 0);
}

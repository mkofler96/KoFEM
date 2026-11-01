// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Thin walls with linear elements (KOF-274). Linear tets lock in bending, so a
// 2 mm wall with one or two of them through it comes out several times too
// stiff — with no error. The study's pre-flight check warns and offers the fix;
// the result says it is too stiff. tests/test_thin_wall_order.mjs measures the
// error this warns about.
//
// fin_two_parts.step: a solid base block (body 1) and a 2 mm fin (body 2).

import path from "node:path";
import { test, expect } from "./coverage";
import { importStep } from "./fixtures/app";
import { openTree, setElementType } from "./fixtures/tree";

const FIN_TWO_PARTS = path.resolve("..", "test_files", "fin_two_parts.step");

interface Store {
  getState(): {
    nodes: unknown[];
    elementOrder: number;
    setElementOrder(order: number): void;
    setResult(r: { displacements: Float64Array; elementOrder: number }): void;
    setMode(mode: string): void;
  };
}
const store = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const state = (
      window as unknown as { __kofemStore: Store }
    ).__kofemStore.getState();
    return { nodes: state.nodes.length, elementOrder: state.elementOrder };
  });

test("a thin wall meshed with linear elements is flagged before and after the solve", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await importStep(page, FIN_TWO_PARTS);
  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill("4");
  await page.getByRole("button", { name: /Mesh STEP volume/i }).click();
  await expect
    .poll(async () => (await store(page)).nodes, { timeout: 120_000 })
    .toBeGreaterThan(0);

  // Linear elements (the default): the fin is flagged, the base is not, and
  // the solve stays available.
  await openTree(page, "static");
  const preflight = page.getByTestId("thin-wall-preflight");
  await expect(preflight).toBeVisible();
  await expect(preflight).toContainText("Body 2: 2 mm wall");
  await expect(preflight).not.toContainText("Body 1");
  await expect(
    page.getByRole("button", { name: /Run static solve/ }),
  ).toBeVisible();

  // One click switches to quadratic elements, and the warning goes.
  await page.getByTestId("use-quadratic").click();
  expect((await store(page)).elementOrder).toBe(2);
  await expect(preflight).toHaveCount(0);

  // Back to linear, the fin as Shell: a Shell body is not checked.
  await page.evaluate(() =>
    (window as unknown as { __kofemStore: Store }).__kofemStore
      .getState()
      .setElementOrder(1),
  );
  await setElementType(page, 2, "shell");
  await openTree(page, "static");
  await expect(page.getByTestId("thin-wall-preflight")).toHaveCount(0);
  await setElementType(page, 2, "solid");

  // A result solved with linear elements carries the note, whatever the order
  // setting is afterwards.
  await page.evaluate(() => {
    const state = (
      window as unknown as { __kofemStore: Store }
    ).__kofemStore.getState();
    state.setResult({
      displacements: new Float64Array(3 * state.nodes.length),
      elementOrder: 1,
    });
    state.setElementOrder(2);
    state.setMode("results");
  });
  const note = page.getByTestId("thin-wall-result");
  await expect(note).toBeVisible();
  await expect(note).toContainText("Body 2: 2 mm wall");
  // The setting is already quadratic: nothing left to switch, re-solve instead.
  await expect(page.getByTestId("use-quadratic")).toHaveCount(0);
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Boundary conditions → interfaces (KOF-170): the faces where bodies touch are
// listed as interface conditions, each opens with its type (Bonded) and is
// shown in the viewport, the list survives save and load, and a body that
// touches nothing is flagged on its Geometry row.

import fs from "fs";
import os from "os";
import path from "path";
import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { gotoApp, importStep } from "./fixtures/app";
import { openBody } from "./fixtures/tree";

const TWO_BOXES = path.resolve("..", "test_files", "two_boxes.stp");
// Three bodies; Body 3 touches neither of the others.
const CRANE_HOOK = path.resolve("..", "test_files", "full-crane-hook.step");

interface InterfaceState {
  interfaces:
    { id: number; bodyA: number; bodyB: number; type: string }[] | null;
  viewRepr: string;
}

const interfaces = (page: Page) =>
  page.evaluate(() => {
    const store = (
      window as unknown as { __kofemStore: { getState(): InterfaceState } }
    ).__kofemStore.getState();
    return store.interfaces;
  });

test("touching bodies list a bonded interface that opens, highlights and survives save and load", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await importStep(page, TWO_BOXES);

  const row = page.getByTestId("tree-interface-1");
  await expect(row).toContainText("Body 1 ↔ Body 2");
  await expect(row).toContainText("bonded");
  // Both bodies touch: neither is flagged.
  await expect(page.getByTestId("tree-body-1")).not.toContainText("unbonded");
  await expect(page.getByTestId("tree-body-2")).not.toContainText("unbonded");

  await row.click();
  await expect(page.getByTestId("panel-title")).toHaveText("Body 1 ↔ Body 2");
  await expect(page.getByTestId("interface-faces-1")).toHaveText("1");
  const type = page.getByTestId("interface-type-1");
  await expect(type).toHaveValue("bonded");
  await expect(type.locator("option")).toHaveText(["Bonded"]);

  // Suppressing a body takes its interfaces out of the analysis.
  await openBody(page, 2);
  await page.getByTestId("body-suppressed-2").check();
  await expect(row).toContainText("inactive");
  await page.getByTestId("body-suppressed-2").uncheck();
  await expect(row).toContainText("bonded");

  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "kofem-interfaces-")),
    "two-boxes.vtu",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save analysis" }).click();
  await (await download).saveAs(file);
  expect(fs.readFileSync(file, "utf8")).toContain("KoFEM");

  await gotoApp(page);
  await page
    .locator('input[type="file"][accept=".vtu,.zip"]')
    .setInputFiles(file);
  await expect(page.getByTestId("tree-interface-1")).toContainText(
    "Body 1 ↔ Body 2",
  );
  expect(await interfaces(page)).toEqual([
    {
      id: 1,
      bodyA: 1,
      bodyB: 2,
      faceIds: [expect.any(Number)],
      type: "bonded",
    },
  ]);
});

test("a body that touches no other body is flagged as unbonded", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await importStep(page, CRANE_HOOK);

  await expect(page.getByTestId("tree-interface-1")).toContainText(
    "Body 1 ↔ Body 2",
  );
  await expect(page.getByTestId("tree-interface-2")).toHaveCount(0);
  await expect(page.getByTestId("tree-body-3")).toContainText("unbonded");
  await expect(page.getByTestId("tree-body-1")).not.toContainText("unbonded");

  await openBody(page, 3);
  await expect(page.getByTestId("body-unbonded-note")).toBeVisible();
  await openBody(page, 1);
  await expect(page.getByTestId("body-unbonded-note")).toHaveCount(0);
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Supports and loads can be renamed from their panels (KOF-339): "Fixed end"
// instead of BC1. The model tree and the panel title follow as the user types,
// a blank name is refused with a message, and the name is saved with the
// analysis. (Re-meshing keeps it: example-remesh.spec.ts renames a group
// before it re-meshes.)

import fs from "fs";
import os from "os";
import path from "path";
import type { Page } from "@playwright/test";
import { test, expect } from "./coverage";
import { bootstrapCantilever } from "./fixtures/cantilever";
import { gotoApp } from "./fixtures/app";
import { openTree } from "./fixtures/tree";

function groupNames(page: Page): Promise<{ bc: string[]; load: string[] }> {
  return page.evaluate(() => {
    const st = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            bcGroups: { name: string }[];
            loadGroups: { name: string }[];
          };
        };
      }
    ).__kofemStore.getState();
    return {
      bc: st.bcGroups.map((g) => g.name),
      load: st.loadGroups.map((g) => g.name),
    };
  });
}

const bcEntry = (page: Page) => page.locator('[data-testid^="tree-bc-"]');
const loadEntry = (page: Page) => page.locator('[data-testid^="tree-load-"]');

test("a support and a load are renamed from their panels, and the tree follows", async ({
  page,
}) => {
  await bootstrapCantilever(page);

  await bcEntry(page).click();
  const name = page.getByTestId("group-name");
  await expect(name).toHaveValue("BC1");
  await name.fill("Fixed end");
  await expect(bcEntry(page)).toHaveText("Fixed end");
  await expect(page.getByTestId("panel-title")).toHaveText("Fixed end");

  await loadEntry(page).click();
  await expect(name).toHaveValue("Load1");
  await name.fill("  Tip load ");
  await expect(loadEntry(page)).toHaveText("Tip load");
  await expect(page.getByTestId("panel-title")).toHaveText("Tip load");

  expect(await groupNames(page)).toEqual({
    bc: ["Fixed end"],
    load: ["Tip load"],
  });
});

test("a blank name is refused with a message, and the group keeps its name", async ({
  page,
}) => {
  await bootstrapCantilever(page);
  await bcEntry(page).click();
  const name = page.getByTestId("group-name");
  const error = page.getByTestId("group-name-error");

  await name.fill("   ");
  await expect(error).toHaveText(
    "A name can't be blank. It stays “BC1” until you type one.",
  );
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await expect(bcEntry(page)).toHaveText("BC1");
  expect((await groupNames(page)).bc).toEqual(["BC1"]);

  await name.fill("Clamp");
  await expect(error).toHaveCount(0);
  await expect(name).toHaveAttribute("aria-invalid", "false");
  await expect(bcEntry(page)).toHaveText("Clamp");
});

test("renaming keeps the result, and the names survive save and reopen", async ({
  page,
}) => {
  await bootstrapCantilever(page);
  await openTree(page, "static");
  await page.getByRole("button", { name: /Run static solve/ }).click();
  await expect(page.getByText(/Max \|U\|/)).toBeVisible();

  // A name is not physics: renaming must not throw the solved result away.
  await bcEntry(page).click();
  await page.getByTestId("group-name").fill("Fixed end");
  await loadEntry(page).click();
  await page.getByTestId("group-name").fill("Tip load");
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __kofemStore: { getState(): { result: unknown } };
          }
        ).__kofemStore.getState().result !== null,
    ),
  ).toBe(true);

  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "kofem-rename-")),
    "renamed.vtu",
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save analysis" }).click();
  await (await download).saveAs(file);

  await gotoApp(page);
  await page
    .locator('input[type="file"][accept=".vtu,.zip"]')
    .setInputFiles(file);
  await expect(bcEntry(page)).toHaveText("Fixed end");
  await expect(loadEntry(page)).toHaveText("Tip load");
  expect(await groupNames(page)).toEqual({
    bc: ["Fixed end"],
    load: ["Tip load"],
  });
});

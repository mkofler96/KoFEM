// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// What a visitor reads when a CAD import fails (KOF-347): a file KoFEM does not
// import, or a STEP/IGES file its reader rejects, names the formats it accepts
// instead of showing the engine's error text.

import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";

const ACCEPTED = "STEP (.step, .stp) and IGES (.igs, .iges)";

test("a file that is not STEP or IGES is refused with the accepted formats", async ({
  page,
}) => {
  await gotoApp(page);
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles({
    name: "bracket.stl",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("solid bracket\n  facet normal 0 0 1\n"),
  });

  const error = page.getByTestId("step-error");
  await expect(error).toHaveText(
    `This file type is not supported. KoFEM imports ${ACCEPTED} files.`,
  );
  await expect(page.getByRole("button", { name: /Import STEP/ })).toBeEnabled();
});

test("a STEP file the reader rejects says how to fix it, not the reader's error", async ({
  page,
}) => {
  await gotoApp(page);
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles({
    name: "bracket.step",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("this is not a STEP file"),
  });

  const error = page.getByTestId("step-error");
  await expect(error).toContainText("Could not read this file as STEP.");
  await expect(error).toContainText(ACCEPTED);
  await expect(error).not.toContainText("STEPControl_Reader");
});

test("a STEP file without an extension is recognised by its header @pipeline", async ({
  page,
}) => {
  await gotoApp(page);
  const fs = await import("fs");
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles({
    name: "tube",
    mimeType: "application/octet-stream",
    buffer: fs.readFileSync("tests/fixtures/tube.stp"),
  });
  await expect(
    page.getByRole("button").filter({ hasText: "Generate mesh" }),
  ).toBeVisible();
  await expect(page.getByTestId("step-error")).toBeHidden();
});

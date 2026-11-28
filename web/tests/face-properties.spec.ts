// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-493: while a tool picks faces, the status bar says what the picked face
// is — its CAD face id, surface type (a cylinder with its diameter), area and
// normal or axis — measured by the engine on the CAD geometry, and shows
// nothing else: no pick prompt (the panel gives it) and no mesh counts.
// Driven on the hollow shaft example: a tube rᵢ = 30, rₒ = 50 mm, 500 mm long
// along z, whose faces are 1 the outer cylinder, 2 the bore, 3 the end z = 0
// and 4 the end z = 500 (annulusStep in examples/gallery/step-prism.mjs).

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { addBoundary, openTree } from "./fixtures/tree";
import { clickModelAt, lookFrom } from "./fixtures/viewport";

async function openShaft(page: Page): Promise<void> {
  await page.goto("/app/?example=shaft-torsion");
  await expect(page.locator("nav")).toBeVisible();
  // The example has loaded once its study can be run.
  await expect(
    page.getByRole("button", { name: /Run static solve/ }),
  ).toBeEnabled();
}

test("the status bar describes the face picked for a support, and only that @pipeline", async ({
  page,
}) => {
  await openShaft(page);
  const bar = page.getByTestId("status-bar");
  await expect(bar).toContainText(/\d+ nodes/);

  await addBoundary(page, "bc");
  await expect(bar).not.toContainText(/\d+ nodes/);
  await expect(bar).not.toContainText("Pick");

  // The outer cylinder: Ø100, 2π · 50 · 500 = 157,080 mm².
  await lookFrom(page, [1, 0.3, 0.3]);
  await clickModelAt(page, [50, 0, 250]);
  await expect(page.getByTestId("picked-face")).toHaveText(
    "Face 1 · cylinder Ø100 · 157,080 mm² · axis Z",
  );
  await expect
    .poll(() =>
      page
        .getByTestId("picked-face")
        .evaluate((info) => info.scrollWidth <= info.clientWidth),
    )
    .toBe(true);
  await expect(bar).not.toContainText(/\d+ nodes/);

  // The loaded end: π · (50² − 30²) = 5,027 mm², facing out along +z.
  await lookFrom(page, [0.3, 0.3, 1]);
  await clickModelAt(page, [0, 40, 500]);
  await expect(page.getByTestId("picked-face")).toHaveText(
    "Face 4 · plane · 5,027 mm² · normal +Z",
  );
});

test("the status bar describes the face picked for a mesh face size @pipeline", async ({
  page,
}) => {
  await openShaft(page);
  await openTree(page, "mesh");
  const bar = page.getByTestId("status-bar");
  await expect(bar).toContainText(/\d+ nodes/);

  await page.getByTestId("face-size-pick").click();
  await expect(bar).not.toContainText(/\d+ nodes/);

  await lookFrom(page, [1, 0.3, 0.3]);
  await clickModelAt(page, [50, 0, 250]);
  await expect(page.getByTestId("picked-face")).toHaveText(
    "Face 1 · cylinder Ø100 · 157,080 mm² · axis Z",
  );
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-312: a thin-walled tube meshed with linear elements gets the thin-wall
// pre-flight warning. A tube has no opposite planar faces, so only the
// curved-wall pass finds it. Shell collapses curved walls too (KOF-448), so
// the advice offers it as for a flat wall.

import { test, expect } from "./coverage";
import { annulusStep } from "../../examples/gallery/step-prism.mjs";
import { gotoApp } from "./fixtures/app";
import { openTree } from "./fixtures/tree";

// 2 mm wall, 40/44 mm bore/outside, 60 mm long.
const TUBE = Buffer.from(annulusStep(20, 22, 60, "thin tube"));

test("a thin tube with linear elements gets the thin-wall warning, with the Shell advice @pipeline", async ({
  page,
}) => {
  await gotoApp(page);
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles({
    name: "thin-tube.step",
    mimeType: "application/octet-stream",
    buffer: TUBE,
  });
  const meshButton = page.getByRole("button", { name: /Generate mesh/ });
  await expect(meshButton).toBeVisible();
  // The suggested element size, linear elements (the default).
  await meshButton.click();
  await expect(page.getByTestId("mesh-summary")).toBeVisible();
  await expect(page.getByTestId("mesh-body-1-edge")).toContainText("mm");
  await expect(page.getByText(/Thin wall/)).toHaveCount(0);

  await openTree(page, "static");
  const warning = page
    .getByTestId("check-fail")
    .filter({ hasText: "Thin wall on body 1" });
  await expect(warning).toHaveCount(1);
  await expect(warning).toContainText("2.0 mm");
  await expect(warning).toContainText(
    "Use quadratic elements (Mesh panel) or set the body to Shell.",
  );
});

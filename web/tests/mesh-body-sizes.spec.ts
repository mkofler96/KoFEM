// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-342: the max element size lives in the Mesh settings and, optionally, on
// each body or region. The mesh summary links each body's own size to the
// body's entry, where it is edited, and Apply to all bodies clears those sizes
// so the whole model meshes at the size in the Mesh settings. Both appear only
// when the model has several bodies or regions; a single body is left as is.

import { test, expect } from "./coverage";
import path from "path";
import { importStep } from "./fixtures/app";
import { openBody, openTree } from "./fixtures/tree";

const TWO_BOXES = path.resolve("..", "test_files", "two_boxes.stp");
const TUBE = path.resolve("tests", "fixtures", "tube.stp");

test("the mesh summary opens a body's own size; Apply to all clears them (KOF-342) @pipeline", async ({
  page,
}) => {
  await importStep(page, TWO_BOXES);

  // Coarse sizes keep the mesh quick; each body sets a finer size of its own.
  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill("5");
  await page.getByTestId("min-element-size").fill("0.5");
  await expect(page.getByTestId("mesh-size-apply-all")).toHaveCount(0);
  await openBody(page, 1);
  await page.getByTestId("region-max-size-1").fill("2.5");
  await openBody(page, 2);
  await page.getByTestId("region-max-size-2").fill("4");

  // The Mesh settings say which bodies the global size does not reach.
  await openTree(page, "mesh");
  await expect(page.getByTestId("mesh-size-apply-all-note")).toHaveText(
    "⚠ Changes 2 bodies: Body 1, Body 2.",
  );
  await page.getByRole("button", { name: /generate mesh/i }).click();
  await expect(page.getByTestId("mesh-region-size-2")).toHaveText("max 4 mm");

  // ✎ opens the body, with its own size in the field.
  await page.getByTestId("mesh-region-edit-2").click();
  await expect(page.getByTestId("panel-title")).toHaveText("Body 2");
  await expect(page.getByTestId("region-max-size-2")).toHaveValue("4");

  // Apply to all clears both bodies' sizes; the mesh is then out of date.
  await openTree(page, "mesh");
  await page.getByTestId("mesh-size-apply-all").click();
  await expect(page.getByTestId("mesh-size-apply-all")).toHaveCount(0);
  await expect(page.getByTestId("mesh-sizes-changed")).toBeVisible();
  await openBody(page, 1);
  await expect(page.getByTestId("region-max-size-1")).toHaveValue("");
  await expect(page.getByTestId("region-max-size-1")).toHaveAttribute(
    "placeholder",
    "5 (mesh setting)",
  );
});

test("a single body with its own size gets no edit link or Apply to all (KOF-342) @pipeline", async ({
  page,
}) => {
  await importStep(page, TUBE);
  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill("10");
  await page.getByTestId("min-element-size").fill("1");
  await openBody(page, 1);
  await page.getByTestId("region-max-size-1").fill("8");

  await openTree(page, "mesh");
  await expect(page.getByTestId("mesh-size-apply-all")).toHaveCount(0);
  await page.getByRole("button", { name: /generate mesh/i }).click();
  await expect(page.getByTestId("mesh-region-size-1")).toHaveText("max 8 mm");
  await expect(page.getByTestId("mesh-region-edit-1")).toHaveCount(0);
  await expect(page.getByTestId("mesh-size-apply-all")).toHaveCount(0);
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The split tool (Geometry step): cut a face of an imported part with a plane so
// a support or a load can sit on part of it — driven entirely through the UI,
// with real clicks on the faces, the way a user builds the MBB beam's pads.

import { test, expect } from "./coverage";
import {
  clickModelAt,
  geometryCounts,
  importStepText,
  splitFaceAt,
} from "./fixtures/split";
import { prismStep } from "../../examples/gallery/step-prism.mjs";

// A plain 300 × 50 × 10 mm block — the MBB design domain before any split:
// six faces, nothing to pick a pad from.
const BLOCK = prismStep(
  [
    [0, 0],
    [300, 0],
    [300, 50],
    [0, 50],
  ],
  10,
  "block",
);

test("split a face with a plane, see the error for a plane that misses, undo", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await importStepText(page, BLOCK);
  expect(await geometryCounts(page)).toEqual({ faces: 6, bodies: 1, edits: 0 });

  await page.getByTestId("split-open").click();
  await expect(page.getByTestId("split-form")).toBeVisible();

  // Top face (y = 50) at mid-span: two cuts carve the 10 mm load pad.
  await splitFaceAt(page, [100, 50, 5], 145);
  expect(await geometryCounts(page)).toEqual({ faces: 7, bodies: 1, edits: 1 });

  // x = 155 lies past the left piece (0 … 145): the engine names the face and
  // what to change instead of silently doing nothing.
  await clickModelAt(page, [100, 50, 5]);
  await page.getByTestId("split-position").fill("155");
  await page.getByTestId("split-apply").click();
  await expect(page.getByTestId("split-error")).toContainText(
    "is not crossed by the plane x = 155 mm",
  );
  expect((await geometryCounts(page)).edits).toBe(1);

  // Drop that face, pick the right piece instead.
  await clickModelAt(page, [100, 50, 5]);
  await splitFaceAt(page, [200, 50, 5], 155);
  expect(await geometryCounts(page)).toEqual({ faces: 8, bodies: 1, edits: 2 });

  await page.getByTestId("split-undo").click();
  expect(await geometryCounts(page)).toEqual({ faces: 7, bodies: 1, edits: 1 });
});

test("split a body in two: the halves are separate bodies, bonded on mesh", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await importStepText(page, BLOCK);
  await page.getByTestId("split-open").click();
  await page.getByTestId("split-mode-bodies").click();
  await page.getByTestId("split-axis").selectOption("x");
  await page.getByTestId("split-position").fill("150");
  await page.getByTestId("split-apply").click();
  await expect
    .poll(async () => (await geometryCounts(page)).bodies, { timeout: 30_000 })
    .toBe(2);
  // 2 × 5 faces of the halves plus the cut, which the reload imprints into one
  // face shared by both — that shared face is what bonds them in the mesh.
  expect((await geometryCounts(page)).faces).toBe(11);
  await expect(page.getByTestId("body-material-2")).toBeVisible();

  await page.getByRole("button", { name: "Close" }).click();
  await page.getByTestId("max-element-size").fill("20");
  await page.getByRole("button", { name: /mesh STEP volume/i }).click();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = (
            window as unknown as {
              __kofemStore: {
                getState(): { elements: { propertyId: number }[] };
              };
            }
          ).__kofemStore.getState();
          return new Set(state.elements.map((e) => e.propertyId)).size;
        }),
      { timeout: 90_000 },
    )
    .toBe(2);
});

// Whether a click on the geometry view would still toggle split faces.
function splitPicking(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: { getState(): { splitPicking: boolean } };
        }
      ).__kofemStore.getState().splitPicking,
  );
}

// The split answers after an await. Closing the tool, or leaving the Geometry
// step, while the worker runs must leave face picking off: the continuation
// used to turn it back on from the state the split started in, behind a closed
// form, so every click on the model kept toggling invisible split faces.
test("closing the tool or leaving the step mid-split leaves picking off", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await importStepText(page, BLOCK);

  // Each pass cuts a fresh piece of the top face: x = 100, then x = 200 on the
  // right-hand piece the first cut left.
  for (const [leave, cut, at] of [
    ["close", 100, [50, 50, 5]],
    ["step", 200, [250, 50, 5]],
  ] as const) {
    const before = (await geometryCounts(page)).edits;
    if (leave === "step")
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "Geometry" })
        .click();
    await page.getByTestId("split-open").click();
    await page.getByTestId("split-position").fill(String(cut));
    await clickModelAt(page, [...at]);
    await expect(page.locator('[data-testid^="split-face-"]')).toHaveCount(1);
    await page.getByTestId("split-apply").click();
    if (leave === "close")
      await page.getByRole("button", { name: "Close" }).click();
    else
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "Constraints" })
        .click();

    // The split itself still lands — the user only stopped looking at it.
    await expect
      .poll(async () => (await geometryCounts(page)).edits, { timeout: 30_000 })
      .toBe(before + 1);
    expect(await splitPicking(page), `after leaving by ${leave}`).toBe(false);
  }
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The split tool (Geometry step): cut a face of an imported part with a plane so
// a support or a load can sit on part of it — driven entirely through the UI,
// with real clicks on the faces, the way a user builds the MBB beam's pads.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
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

// The split answers after an await. Hold every split_geometry request in the
// page for a while, so the user's next action provably lands while the worker
// is still busy — a fast machine must not turn these into tests of nothing.
async function delaySplits(page: Page, ms: number): Promise<void> {
  await page.addInitScript((delay) => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      ...args: Parameters<Worker["postMessage"]>
    ) {
      const type = (args[0] as { type?: string } | null)?.type;
      if (type === "split_geometry")
        setTimeout(() => post.apply(this, args), delay);
      else post.apply(this, args);
    } as Worker["postMessage"];
  }, ms);
}

function storeState(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            splitPicking: boolean;
            pickMode: string | null;
            pendingFaces: unknown[];
            selectedFace: unknown;
          };
        };
      }
    ).__kofemStore.getState();
    return {
      splitPicking: state.splitPicking,
      pickMode: state.pickMode,
      picked: state.pendingFaces.length + (state.selectedFace ? 1 : 0),
    };
  });
}

// Start a split of the top face at x = `cut` and leave it running.
async function startSplit(page: Page, cut: number): Promise<number> {
  const before = (await geometryCounts(page)).edits;
  await page.getByTestId("split-open").click();
  await page.getByTestId("split-position").fill(String(cut));
  await clickModelAt(page, [100, 50, 5]);
  await expect(page.locator('[data-testid^="split-face-"]')).toHaveCount(1);
  await page.getByTestId("split-apply").click();
  return before;
}

const nav = (page: Page, step: string) =>
  page.getByRole("navigation").getByRole("button", { name: step }).click();

// What the user does while the split runs — each must leave face picking off
// once it lands. The continuation used to turn it back on from the state the
// split started in (open, faces), behind a closed form or a Bodies form, so
// every click on the model kept toggling invisible split faces.
const MID_SPLIT: [string, (page: Page) => Promise<void>][] = [
  [
    "closes the tool",
    (page) => page.getByRole("button", { name: "Close" }).click(),
  ],
  ["leaves the Geometry step", (page) => nav(page, "Constraints")],
  [
    "switches to Bodies",
    (page) => page.getByTestId("split-mode-bodies").click(),
  ],
];

for (const [action, act] of MID_SPLIT) {
  test(`a split that lands after the user ${action} leaves picking off`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await delaySplits(page, 1500);
    await importStepText(page, BLOCK);
    const before = await startSplit(page, 150);
    await act(page);
    // Still in flight: the action really raced the split.
    expect((await geometryCounts(page)).edits).toBe(before);
    // The split itself still lands — the user only stopped looking at it.
    await expect
      .poll(async () => (await geometryCounts(page)).edits, { timeout: 30_000 })
      .toBe(before + 1);
    expect((await storeState(page)).splitPicking).toBe(false);
  });
}

test("a split that fails after the tool was closed still reports why", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await delaySplits(page, 1500);
  await importStepText(page, BLOCK);
  await startSplit(page, 500); // misses the 300 mm face
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("split-form")).toBeHidden();
  await expect(page.getByTestId("split-error")).toContainText(
    "is not crossed by the plane x = 500 mm",
    { timeout: 30_000 },
  );
  // Reopening shows the error until the next split or a dismissal.
  await page.getByTestId("split-open").click();
  await expect(page.getByTestId("split-error")).toBeVisible();
});

test("a split that lands during a BC pick ends the pick session", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await delaySplits(page, 1500);
  await importStepText(page, BLOCK);
  await page.getByTestId("max-element-size").fill("20");
  await page.getByTestId("min-element-size").fill("2");
  await page.getByRole("button", { name: /mesh STEP volume/i }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __kofemStore: { getState(): { nodes: unknown[] } };
              }
            ).__kofemStore.getState().nodes.length,
        ),
      { timeout: 90_000 },
    )
    .toBeGreaterThan(0);

  const before = await startSplit(page, 150);
  await nav(page, "Constraints");
  // The split tool switched the view to the CAD geometry; faces are picked for
  // a BC on the mesh surface.
  await page.getByRole("button", { name: "Surface", exact: true }).click();
  await page.getByRole("button", { name: "Add BC" }).click();
  await clickModelAt(page, [100, 50, 5]);
  expect(await storeState(page)).toMatchObject({ pickMode: "bc", picked: 1 });
  expect((await geometryCounts(page)).edits).toBe(before);

  await expect
    .poll(async () => (await geometryCounts(page)).edits, { timeout: 30_000 })
    .toBe(before + 1);
  // The mesh the pick was made on is gone, and with it the BC section that
  // could have cancelled the session.
  expect(await storeState(page)).toEqual({
    splitPicking: false,
    pickMode: null,
    picked: 0,
  });
});

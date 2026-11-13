// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The split tool (Geometry step): cut a face of an imported part with a plane so
// a support or a load can sit on part of it — driven entirely through the UI,
// with real clicks on the faces, the way a user builds the MBB beam's pads.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { geometryCounts, importStepText, splitFaceAt } from "./fixtures/split";
import { clickModelAt } from "./fixtures/viewport";
import { prismStep } from "../../examples/gallery/step-prism.mjs";
import { openTree, addBoundary } from "./fixtures/tree";

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
  await importStepText(page, BLOCK);
  expect(await geometryCounts(page)).toEqual({ faces: 6, bodies: 1, edits: 0 });

  await openTree(page, "split");
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

// Element count of each region of the current mesh, keyed by solid id.
async function elementsPerRegion(page: Page): Promise<Record<number, number>> {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): { elements: { propertyId: number }[] };
        };
      }
    ).__kofemStore.getState();
    const counts: Record<number, number> = {};
    for (const e of state.elements)
      counts[e.propertyId] = (counts[e.propertyId] ?? 0) + 1;
    return counts;
  });
}

// KOF-257: a body split makes regions of the same body — connected at the cut,
// listed under the body, not as an interface — each with its own mesh size and
// optimization role, and a region can be promoted to a body of its own.
test("split a body into regions: one body, connected, each meshed at its own size @pipeline", async ({
  page,
}) => {
  await importStepText(page, BLOCK);
  await openTree(page, "split");
  await page.getByTestId("split-open").click();
  await page.getByTestId("split-mode-bodies").click();
  await expect(page.getByTestId("split-mode-bodies")).toHaveText("Regions");
  await page.getByTestId("split-axis").selectOption("x");
  await page.getByTestId("split-position").fill("150");
  await page.getByTestId("split-apply").click();
  await expect.poll(async () => (await geometryCounts(page)).bodies).toBe(2);
  // 2 × 5 faces of the halves plus the cut, which the reload imprints into one
  // face shared by both — that shared face is what connects them in the mesh.
  expect((await geometryCounts(page)).faces).toBe(11);

  // Still one body, now with two regions under it; the cut is not an interface.
  await expect(page.getByTestId("tree-body-1")).toContainText("2 regions");
  await expect(page.getByTestId("tree-region-1")).toHaveText(/Region 1/);
  await expect(page.getByTestId("tree-region-2")).toHaveText(/Region 2/);
  await expect(page.getByTestId("tree-body-2")).toHaveCount(0);
  await expect(page.getByTestId("tree-interface-1")).toHaveCount(0);

  // Each half is drawn closed: the shared cut face is tessellated for both
  // regions, so hiding one leaves the other a solid rather than an open shell
  // you can see into.
  const facesPerBody = await page.evaluate(() => {
    const surface = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            stepSurface: { bodyIds?: number[]; faceIds?: number[] };
          };
        };
      }
    ).__kofemStore.getState().stepSurface;
    const faces: Record<number, Set<number>> = {};
    surface.faceIds?.forEach((face, tri) => {
      const body = surface.bodyIds?.[tri];
      if (body === undefined) return;
      (faces[body] ??= new Set()).add(face);
    });
    return Object.values(faces).map((set) => set.size);
  });
  expect(facesPerBody).toEqual([6, 6]);

  // The body's panel now lists its regions instead of the split tool.
  await expect(page.getByTestId("body-region-2")).toBeVisible();

  // Region 1 meshes finer than the rest; Region 2 is kept solid by the
  // optimizer.
  await page.getByTestId("tree-region-1").click();
  await page.getByTestId("region-max-size-1").fill("6");
  await page.getByTestId("tree-region-2").click();
  await page.getByTestId("region-role-2").selectOption("solid");

  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill("20");
  await page.getByTestId("min-element-size").fill("2");
  await page.getByRole("button", { name: /generate mesh/i }).click();
  await expect
    .poll(async () => Object.keys(await elementsPerRegion(page)).length)
    .toBe(2);
  // Same volume on both sides of the cut, so the finer region has many more
  // elements.
  const counts = await elementsPerRegion(page);
  expect(counts[1]).toBeGreaterThan(3 * counts[2]);
  await expect(page.getByTestId("mesh-region-size-1")).toHaveText("max 6 mm");
  // Its ✎ opens the region, where the size is edited (KOF-342).
  await page.getByTestId("mesh-region-edit-1").click();
  await expect(page.getByTestId("panel-title")).toHaveText("Region 1");
  await expect(page.getByTestId("region-max-size-1")).toHaveValue("6");

  // Changing the region size marks the mesh out of date.
  await page.getByTestId("tree-region-1").click();
  await page.getByTestId("region-max-size-1").fill("8");
  await expect(page.getByTestId("tree-mesh-1")).toContainText("out of date");
  await page.getByTestId("region-max-size-1").fill("6");
  await expect(page.getByTestId("tree-mesh-1")).not.toContainText(
    "out of date",
  );

  // Promoted, Region 2 is Body 2, and the cut becomes an interface.
  await page.getByTestId("tree-region-2").click();
  await page.getByTestId("region-promote-2").click();
  await expect(page.getByTestId("tree-body-2")).toBeVisible();
  await expect(page.getByTestId("panel-title")).toHaveText("Body 2");
  await expect(page.getByTestId("tree-region-1")).toHaveCount(0);
  await expect(page.getByTestId("tree-interface-1")).toHaveText(
    /Body 1 ↔ Body 2/,
  );
  // It keeps its settings.
  await expect(page.getByTestId("region-role-2")).toHaveValue("solid");
});

// The split answers after an await. Hold every split_geometry request in the
// page until the test releases it, so the user's next action provably lands
// while the split is still in flight, on any machine and however busy it is.
// The returned function lets the held requests go, and later ones straight
// through.
async function holdSplits(page: Page): Promise<() => Promise<void>> {
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    const held: (() => void)[] = [];
    let released = false;
    Worker.prototype.postMessage = function (
      this: Worker,
      ...args: Parameters<Worker["postMessage"]>
    ) {
      const type = (args[0] as { type?: string } | null)?.type;
      if (type === "split_geometry" && !released)
        held.push(() => post.apply(this, args));
      else post.apply(this, args);
    } as Worker["postMessage"];
    (window as unknown as { __releaseSplits: () => number }).__releaseSplits =
      () => {
        released = true;
        const count = held.length;
        for (const send of held.splice(0)) send();
        return count;
      };
  });
  return async () => {
    const count = await page.evaluate(() =>
      (
        window as unknown as { __releaseSplits: () => number }
      ).__releaseSplits(),
    );
    // A test that released nothing raced nothing.
    expect(count, "no split request was waiting to be released").toBe(1);
  };
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
  await openTree(page, "split");
  await page.getByTestId("split-open").click();
  await page.getByTestId("split-position").fill(String(cut));
  await clickModelAt(page, [100, 50, 5]);
  await expect(page.locator('[data-testid^="split-face-"]')).toHaveCount(1);
  await page.getByTestId("split-apply").click();
  return before;
}

// What the user does while the split runs — each must leave face picking off
// once it lands. The continuation used to turn it back on from the state the
// split started in (open, faces), behind a closed form or a Bodies form, so
// every click on the model kept toggling invisible split faces.
const MID_SPLIT: [string, (page: Page) => Promise<void>][] = [
  [
    "closes the tool",
    (page) => page.getByRole("button", { name: "Close" }).click(),
  ],
  ["leaves the split tool", (page) => openTree(page, "mesh")],
  [
    "switches to Bodies",
    (page) => page.getByTestId("split-mode-bodies").click(),
  ],
];

for (const [action, act] of MID_SPLIT) {
  test(`a split that lands after the user ${action} leaves picking off`, async ({
    page,
  }) => {
    const releaseSplit = await holdSplits(page);
    await importStepText(page, BLOCK);
    const before = await startSplit(page, 150);
    await act(page);
    // Still in flight: the action really raced the split.
    expect((await geometryCounts(page)).edits).toBe(before);
    await releaseSplit();
    // The split itself still lands — the user only stopped looking at it.
    await expect
      .poll(async () => (await geometryCounts(page)).edits)
      .toBe(before + 1);
    expect((await storeState(page)).splitPicking).toBe(false);
  });
}

test("a split that fails after the tool was closed still reports why", async ({
  page,
}) => {
  const releaseSplit = await holdSplits(page);
  await importStepText(page, BLOCK);
  await startSplit(page, 500); // misses the 300 mm face
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("split-form")).toBeHidden();
  await releaseSplit();
  await expect(page.getByTestId("split-error")).toContainText(
    "is not crossed by the plane x = 500 mm",
  );
  // Reopening shows the error until the next split or a dismissal.
  await openTree(page, "split");
  await page.getByTestId("split-open").click();
  await expect(page.getByTestId("split-error")).toBeVisible();
});

test("a split that lands during a BC pick ends the pick session", async ({
  page,
}) => {
  const releaseSplit = await holdSplits(page);
  await importStepText(page, BLOCK);
  await page.getByTestId("max-element-size").fill("20");
  await page.getByTestId("min-element-size").fill("2");
  await page.getByRole("button", { name: /generate mesh/i }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __kofemStore: { getState(): { nodes: unknown[] } };
            }
          ).__kofemStore.getState().nodes.length,
      ),
    )
    .toBeGreaterThan(0);

  const before = await startSplit(page, 150);
  // The split tool switched the view to the CAD geometry; faces are picked for
  // a BC on the mesh surface.
  await page.getByRole("button", { name: "Surface", exact: true }).click();
  await addBoundary(page, "bc");
  await clickModelAt(page, [100, 50, 5]);
  expect(await storeState(page)).toMatchObject({ pickMode: "bc", picked: 1 });
  expect((await geometryCounts(page)).edits).toBe(before);

  // The pick is made; now the split lands.
  await releaseSplit();
  await expect
    .poll(async () => (await geometryCounts(page)).edits)
    .toBe(before + 1);
  // The mesh the pick was made on is gone, and with it the BC section that
  // could have cancelled the session.
  expect(await storeState(page)).toEqual({
    splitPicking: false,
    pickMode: null,
    picked: 0,
  });
});

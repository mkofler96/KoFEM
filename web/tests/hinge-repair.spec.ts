// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Parts the mesher used to fail on with a trap or a misleading error, and the
// hinge warning and repairs on the mesh panel, all through the real engine.

import path from "path";
import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { importStep } from "./fixtures/app";
import { geometryCounts } from "./fixtures/split";
import { addMaterial, openBody, openTree } from "./fixtures/tree";

// A plate and an R3.05 pin on a shared base. The pin is pushed 1e-9 mm into the
// plate's face x = -9, so the two touch along y = 0, z = 0…14.
const HINGE = path.resolve("..", "test_files", "hinge_contact.step");
// A revolved B-spline solid whose ends collapse to a ring of radius 1e-8 mm: OCCT
// calls them degenerate edges, but computes a non-zero length for them.
const COLLAPSED = path.resolve(
  "..",
  "test_files",
  "nearly_collapsed_spline.step",
);

// A plate with a pin tangent to it that ends below the plate's top, so the fuse
// box's end stands proud. OCCT's raw fuse leaves an invalid wire on this.
const HINGE_FREE_END = path.resolve("..", "test_files", "hinge_free_end.step");
// A block with a blind hole ending in a sharp cone: one full cone face closing at
// its tip, which Netgen's surface mesh fails on at every element size.
const CONE_TIP = path.resolve("..", "test_files", "cone_tip_bore.step");
// tube.stp with two face splits 0.01 mm apart across its outer cylinder: a ring
// far narrower than any element, which Netgen's surface mesh gives up on.
const SLIVER_RING = path.resolve("..", "test_files", "tube_sliver_ring.step");

async function setSizes(page: Page, max: string, min: string): Promise<void> {
  await page.getByTestId("max-element-size").fill(max);
  await page.getByTestId("min-element-size").fill(min);
}

async function mesh(page: Page): Promise<void> {
  await page.getByRole("button").filter({ hasText: "Generate mesh" }).click();
}

async function expectMeshed(page: Page): Promise<void> {
  await expect(
    page.getByRole("button").filter({ hasText: "Regenerate mesh" }),
  ).toBeVisible();
  await expect(page.getByTestId("meshing-error")).toHaveCount(0);
  await expect(page.getByTestId("mesh-overlap-card")).toHaveCount(0);
}

async function meshIntoHingeWarning(page: Page): Promise<void> {
  await importStep(page, HINGE);
  await setSizes(page, "2", "0.2");
  await mesh(page);
  await expect(page.getByTestId("hinge-warning")).toContainText(
    "Geometric singularity detected (hinge)",
  );
  await expect(page.getByTestId("meshing-error")).toHaveCount(0);
}

test("a nearly collapsed spline end meshes instead of trapping", async ({
  page,
}) => {
  await importStep(page, COLLAPSED);
  await setSizes(page, "1", "0.1");
  await mesh(page);
  await expectMeshed(page);
});

test("connect repairs a hinge so the part meshes @pipeline", async ({
  page,
}) => {
  await meshIntoHingeWarning(page);
  const overlap = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            meshOverlaps: {
              kind: string;
              hinge?: { length: number; start: number[] };
            }[];
          };
        };
      }
    ).__kofemStore.getState();
    return state.meshOverlaps.map((o) => ({
      kind: o.kind,
      length: o.hinge?.length,
      x: o.hinge && Array.from(o.hinge.start)[0],
    }));
  });
  expect(overlap).toHaveLength(1);
  expect(overlap[0].kind).toBe("hinge");
  expect(overlap[0].length).toBeCloseTo(14, 3);
  expect(overlap[0].x).toBeCloseTo(-9, 3);

  await page.getByTestId("hinge-repair-width").fill("3");
  await page.getByTestId("hinge-connect").click();
  await expect.poll(async () => (await geometryCounts(page)).edits).toBe(1);
  expect((await geometryCounts(page)).bodies).toBe(1);
  await expect(page.getByTestId("mesh-overlap-card")).toHaveCount(0);

  await mesh(page);
  await expectMeshed(page);
});

test("connect repairs a hinge whose raw fuse is invalid @pipeline", async ({
  page,
}) => {
  await importStep(page, HINGE_FREE_END);
  await setSizes(page, "2", "0.2");
  await mesh(page);
  await expect(page.getByTestId("hinge-warning")).toBeVisible();
  await page.getByTestId("hinge-connect").click();
  await expect.poll(async () => (await geometryCounts(page)).edits).toBe(1);
  await expect(page.getByTestId("mesh-overlap-error")).toHaveCount(0);

  await mesh(page);
  await expectMeshed(page);
});

test("splitting a sharp cone tip lets the part mesh @pipeline", async ({
  page,
}) => {
  // The page must stay usable: Netgen prints four lines per overlapping pair.
  const pairLines: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Intersecting elements"))
      pairLines.push(message.text());
  });
  await importStep(page, CONE_TIP);
  await setSizes(page, "1", "0.1");
  await mesh(page);
  await expect(page.getByTestId("cone-warning")).toBeVisible();
  expect(pairLines).toEqual([]);

  await page.getByTestId("cone-split").click();
  await expect.poll(async () => (await geometryCounts(page)).edits).toBe(1);
  await expect(page.getByTestId("mesh-overlap-card")).toHaveCount(0);

  await mesh(page);
  await expectMeshed(page);
});

// Netgen reported success with the ring unmeshed, and the volume fill ran on the
// rest: a broken mesh, a Geomsearch trap or overlaps that aren't there (KOF-292).
test("a face too narrow to mesh is named instead of volume-filled @pipeline", async ({
  page,
}) => {
  await importStep(page, SLIVER_RING);
  await setSizes(page, "5", "0.5");
  await mesh(page);
  await expect(page.getByTestId("unmeshed-warning")).toContainText(
    "couldn't mesh 1 face, highlighted in the view (0.01 mm wide)",
  );
  await expect(page.getByTestId("meshing-error")).toHaveCount(0);
  await expect(page.getByTestId("surface-overlap-warning")).toHaveCount(0);
  await expect(
    page.getByRole("button").filter({ hasText: "Regenerate mesh" }),
  ).toHaveCount(0);

  // Narrower than the 0.5 mm minimum element size: removal is offered, with
  // the accuracy note, and the part meshes after it.
  await expect(page.getByTestId("unmeshed-remove-note")).toContainText(
    "fix it in CAD",
  );
  await page.getByTestId("unmeshed-remove").click();
  await expect.poll(async () => (await geometryCounts(page)).edits).toBe(1);
  await expect(page.getByTestId("mesh-overlap-card")).toHaveCount(0);
  await mesh(page);
  await expectMeshed(page);
});

test("a face wider than the minimum element size is not offered for removal @pipeline", async ({
  page,
}) => {
  await importStep(page, SLIVER_RING);
  await setSizes(page, "5", "0.005");
  await mesh(page);
  await expect(page.getByTestId("unmeshed-warning")).toContainText(
    "Try a smaller element size",
  );
  await expect(page.getByTestId("unmeshed-remove")).toHaveCount(0);
});

// OCCT stored this part's contact as an edge the two faces share. Cutting through
// it leaves invalid geometry, which must be refused rather than handed to the mesher.
test("a separate that leaves invalid geometry is refused and changes nothing @pipeline", async ({
  page,
}) => {
  await meshIntoHingeWarning(page);
  await page.getByTestId("hinge-repair-width").fill("3");
  await page.getByTestId("hinge-separate").click();
  await expect(page.getByTestId("mesh-overlap-error")).toContainText(
    "Separating here left invalid geometry",
  );
  expect((await geometryCounts(page)).edits).toBe(0);
  await expect(page.getByTestId("hinge-warning")).toBeVisible();
});

test("bodies keep their settings when a separate splits one of them", async ({
  page,
}) => {
  await importStep(page, path.resolve("..", "test_files", "two_boxes.stp"));
  await addMaterial(page);
  await page
    .getByTestId("material-color")
    .locator("xpath=ancestor::div[contains(@class,'inlineForm')]")
    .getByRole("button", { name: "Save" })
    .click();
  await openBody(page, 2);
  await page.getByTestId("body-material-2").selectOption("2");
  await page.getByTestId("body-suppressed-2").check();

  // A line across the first box (x 0–20, y 0–10, z 0–10) at x = 10: the 12 mm
  // repair width spans y, so the cut goes all the way through.
  await openTree(page, "mesh");
  await page.evaluate(() => {
    (
      window as unknown as {
        __kofemStore: {
          getState(): { setMeshOverlaps(overlaps: unknown[]): void };
        };
      }
    ).__kofemStore
      .getState()
      .setMeshOverlaps([
        {
          kind: "hinge",
          faceIds: [1, 2],
          bodyId: 1,
          positions: [10, 0, 0, 10, 10, 0, 10, 10, 10],
          hinge: {
            start: [10, 5, -1],
            end: [10, 5, 11],
            normal: [1, 0, 0],
            length: 12,
          },
        },
      ]);
  });
  await page.getByTestId("hinge-repair-width").fill("12");
  await page.getByTestId("hinge-separate").click();
  await expect.poll(async () => (await geometryCounts(page)).bodies).toBe(3);

  const bodies = await page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: {
            getState(): {
              properties: {
                id: number;
                materialId: number;
                suppressed?: boolean;
              }[];
            };
          };
        }
      ).__kofemStore.getState().properties,
  );
  expect(
    bodies.map((p) => ({
      id: p.id,
      materialId: p.materialId,
      suppressed: Boolean(p.suppressed),
    })),
  ).toEqual([
    { id: 1, materialId: 1, suppressed: false },
    { id: 2, materialId: 1, suppressed: false },
    { id: 3, materialId: 2, suppressed: true },
  ]);
});

test("a repair with no usable width is refused", async ({ page }) => {
  await meshIntoHingeWarning(page);
  await page.getByTestId("hinge-repair-width").fill("0");
  await page.getByTestId("hinge-connect").click();
  await expect(page.getByTestId("mesh-overlap-error")).toContainText(
    "positive number",
  );
  expect((await geometryCounts(page)).edits).toBe(0);
});

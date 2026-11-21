// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-413: a mesh that holds a body the body table does not know (Netgen
// split a domain of the imported part) does not quietly give that body the
// first material. The mesh panel says so, the body is marked in the tree, and
// the solve waits until the user chooses its material or keeps the offer.

import { test, expect, type Page } from "./coverage";
import { gotoApp } from "./fixtures/app";
import { fakeImport } from "./fixtures/mesh";
import { openBody, openTree } from "./fixtures/tree";

// Stand in for a finished mesh of the injected cube that came back with two
// bodies: one tetrahedron on body 1 (known) and one on body 2 (new).
async function fakeSplitMesh(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as unknown as {
        __kofemStore: {
          getState(): {
            applyMeshResult(
              nodes: { id: number; x: number; y: number; z: number }[],
              elements: {
                id: number;
                type: string;
                nodeIds: number[];
                propertyId: number;
              }[],
              modelName: string,
              meshSizes: {
                max: number;
                min: number;
                regions: Record<number, number>;
              },
            ): void;
          };
        };
      }
    ).__kofemStore
      .getState()
      .applyMeshResult(
        [
          { id: 1, x: 0, y: 0, z: 0 },
          { id: 2, x: 1, y: 0, z: 0 },
          { id: 3, x: 0, y: 1, z: 0 },
          { id: 4, x: 0, y: 0, z: 1 },
          { id: 5, x: 1, y: 1, z: 1 },
        ],
        [
          { id: 1, type: "CTETRA", nodeIds: [1, 2, 3, 4], propertyId: 1 },
          { id: 2, type: "CTETRA", nodeIds: [2, 3, 4, 5], propertyId: 2 },
        ],
        "STEP Volume Mesh",
        { max: 1, min: 0.1, regions: {} },
      );
  });
}

test("a body the mesh added waits for its material before the solve (KOF-413)", async ({
  page,
}) => {
  await gotoApp(page);
  await fakeImport(page);
  await fakeSplitMesh(page);

  // The mesh panel names the new body.
  await openTree(page, "mesh");
  await expect(page.getByTestId("remesh-notice")).toContainText(
    "body 2 is new — choose its material",
  );

  // The tree marks it, and the solve's pre-flight refuses.
  await expect(page.getByTestId("tree-body-2")).toContainText(
    "choose material",
  );
  await openTree(page, "static");
  await expect(page.getByTestId("check-fail").first()).toContainText(
    "Choose the material of body 2",
  );

  // Keeping the offered material confirms it.
  await openBody(page, 2);
  await page.getByTestId("body-material-confirm-2").click();
  await expect(page.getByTestId("body-material-confirm-2")).toHaveCount(0);
  await expect(page.getByTestId("tree-body-2")).not.toContainText(
    "choose material",
  );
  await openTree(page, "static");
  await expect(page.getByText("Choose the material of body 2")).toHaveCount(0);
});

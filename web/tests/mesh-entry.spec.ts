// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-257: the Mesh entry of the model tree is the mesh settings and a Generate
// action until a mesh exists; then it is the mesh, with a Regenerate action
// that says when the settings no longer match the mesh.

import { test, expect, type Page } from "./coverage";
import { gotoApp } from "./fixtures/app";
import { fakeImport } from "./fixtures/mesh";

// Stand in for a finished mesh of the injected cube: one tetrahedron, made at
// the given sizes. What the panel shows depends only on the store.
async function fakeMesh(page: Page, max: number, min: number): Promise<void> {
  await page.evaluate(
    ({ max, min }) => {
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
                meshSizes: { max: number; min: number },
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
          ],
          [{ id: 1, type: "CTETRA", nodeIds: [1, 2, 3, 4], propertyId: 1 }],
          "STEP Volume Mesh",
          { max, min },
        );
    },
    { max, min },
  );
}

test("the mesh entry shows settings first, then the mesh with Regenerate (KOF-257)", async ({
  page,
}) => {
  await gotoApp(page);
  await fakeImport(page);

  // No mesh yet: "+ Add" holds the settings and Generate.
  const title = page.getByTestId("panel-title");
  await expect(title).toHaveText("New mesh");
  await expect(page.getByTestId("max-element-size")).toBeVisible();
  await expect(page.getByTestId("mesh-generate")).toHaveText(/Generate mesh/);
  await expect(page.getByTestId("mesh-summary")).toHaveCount(0);

  await page.getByTestId("max-element-size").fill("0.2");
  await page.getByTestId("min-element-size").fill("0.02");
  await fakeMesh(page, 0.2, 0.02);

  // The mesh is an entry of its own; a model has one, so "+ Add" goes.
  await expect(title).toHaveText("Volume mesh");
  await expect(page.getByTestId("tree-mesh-1")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByTestId("tree-mesh-1")).toContainText("4 nodes");
  await expect(page.getByTestId("tree-add-mesh")).toHaveCount(0);
  await expect(page.getByTestId("mesh-made-with")).toHaveText(
    "max 0.2 mm, min 0.02 mm",
  );
  await expect(page.getByTestId("mesh-generate")).toHaveText(/Regenerate mesh/);
  await expect(page.getByTestId("mesh-sizes-changed")).toHaveCount(0);

  // A changed size marks the mesh out of date, in the panel and the tree.
  await page.getByTestId("max-element-size").fill("0.1");
  await expect(page.getByTestId("mesh-sizes-changed")).toContainText(
    "made with max 0.2 mm, min 0.02 mm",
  );
  await expect(page.getByTestId("tree-mesh-1")).toContainText("out of date");

  // The typed settings survive a trip to another entry.
  await page.getByTestId("tree-add-materials").click();
  await page.getByTestId("tree-mesh-1").click();
  await expect(page.getByTestId("max-element-size")).toHaveValue("0.1");
  await expect(page.getByTestId("mesh-sizes-changed")).toBeVisible();

  // Back to the sizes of the mesh: it matches again.
  await page.getByTestId("max-element-size").fill("0.2");
  await expect(page.getByTestId("mesh-sizes-changed")).toHaveCount(0);
  await expect(page.getByTestId("tree-mesh-1")).toContainText("4 nodes");
});

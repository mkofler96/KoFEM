// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// An opened example whose recipe splits the imported geometry re-meshes with
// every support and load on the same CAD faces (KOF-322).
//
// The .vtu's CAD face ids number the faces of the geometry after the splits.
// The app must therefore restore <id>.model.step (that geometry), not <id>.step
// (the file the page offers for import, before the splits): re-meshed from the
// import, a group would follow its face id onto another face, or be dropped.
//
// The example here is a throwaway, built by the same node-side pipeline as the
// published ones (examples/validation/lib/pipeline.mjs) and served at the URLs
// the app's loader fetches: a 200 × 40 × 20 mm block whose bottom face is cut
// at x = 100, clamped on the left piece and loaded on the right piece. Only
// the split makes those two faces, so only the post-split geometry has them.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { prismStep } from "../../examples/gallery/step-prism.mjs";
import { buildFromRecipe } from "../../examples/validation/lib/pipeline.mjs";
import { buildAnalysisFile } from "../../examples/validation/lib/app-model.mjs";
import { openTree } from "./fixtures/tree";
import type { Recipe } from "./fixtures/recipe";

const ID = "remesh-after-split";
const LENGTH = 200;
const CUT = 100;
const MESH = 10;
const REMESH = 7;

const recipe: Recipe = {
  step: () =>
    prismStep(
      [
        [0, 0],
        [LENGTH, 0],
        [LENGTH, 40],
        [0, 40],
      ],
      20,
      "Split block",
    ),
  splits: [
    {
      mode: "faces",
      faces: [{ at: [50, 0, 10] }],
      origin: [CUT, 0, 0],
      normal: [1, 0, 0],
    },
  ],
  discretization: { kind: "solid" },
  mesh: { maxElementSize: MESH, order: 1 },
  material: { name: "Steel", young: 210000, poisson: 0.3, density: 7.85e-9 },
  supports: [
    {
      name: "Left pad",
      faces: [{ at: [50, 0, 10] }],
      dofs: [0, 1, 2],
      value: 0,
    },
  ],
  loads: [
    {
      name: "Right pad",
      kind: "force",
      faces: [{ at: [150, 0, 10] }],
      components: [0, -1000, 0],
    },
  ],
  readout: {
    quantity: "Pad displacement",
    probe: {
      kind: "displacement",
      component: 1,
      faces: [{ at: [150, 0, 10] }],
      unit: "mm",
    },
    formula: "none (a throwaway model)",
    reference: 1,
  },
};

interface GroupState {
  name: string;
  cadFaceIds: (number | undefined)[];
  nodeIds: number[];
}
interface ModelState {
  stepBytes: number[] | null;
  isMeshing: boolean;
  remeshNotice: string | null;
  nodes: { id: number; x: number; y: number; z: number }[];
  groups: GroupState[];
}

function modelState(page: Page): Promise<ModelState> {
  return page.evaluate(() => {
    type Group = {
      name: string;
      faces: { cadFaceId?: number; nodeIds: number[] }[];
    };
    const st = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            stepBytes: Uint8Array | null;
            isMeshing: boolean;
            remeshNotice: string | null;
            nodes: { id: number; x: number; y: number; z: number }[];
            bcGroups: Group[];
            loadGroups: Group[];
          };
        };
      }
    ).__kofemStore.getState();
    return {
      stepBytes: st.stepBytes ? Array.from(st.stepBytes) : null,
      isMeshing: st.isMeshing,
      remeshNotice: st.remeshNotice,
      nodes: st.nodes.map(({ id, x, y, z }) => ({ id, x, y, z })),
      groups: [...st.bcGroups, ...st.loadGroups].map((g) => ({
        name: g.name,
        cadFaceIds: g.faces.map((f) => f.cadFaceId),
        nodeIds: [...new Set(g.faces.flatMap((f) => f.nodeIds))].sort(
          (a, b) => a - b,
        ),
      })),
    };
  });
}

// The mesh nodes on the bottom face (y = 0) left or right of the cut: what a
// fresh pick of that piece gives on this mesh.
function padNodes(state: ModelState, side: "left" | "right"): number[] {
  const tol = 1e-6 * LENGTH;
  return state.nodes
    .filter(
      (n) =>
        Math.abs(n.y) < tol &&
        (side === "left" ? n.x <= CUT + tol : n.x >= CUT - tol),
    )
    .map((n) => n.id)
    .sort((a, b) => a - b);
}

test("an example with a split re-meshes with its groups on the same CAD faces", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const build = await buildFromRecipe(ID, recipe);
  const vtu = buildAnalysisFile(build, "Re-mesh after a split");
  await page.route(`**/examples/${ID}.vtu`, (route) =>
    route.fulfill({ body: vtu, contentType: "application/xml" }),
  );
  await page.route(`**/examples/${ID}.model.step`, (route) =>
    route.fulfill({
      body: Buffer.from(build.stepBytes),
      contentType: "application/octet-stream",
    }),
  );
  // The import file: what a loader restoring the wrong file would get.
  await page.route(`**/examples/${ID}.step`, (route) =>
    route.fulfill({
      body: build.stepText,
      contentType: "application/octet-stream",
    }),
  );

  await page.goto(`/app/?example=${ID}`);
  await expect(page.locator("nav")).toBeVisible();
  // The geometry is restored by a second fetch after the .vtu has loaded.
  await expect
    .poll(async () => (await modelState(page)).stepBytes?.length ?? 0, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  const opened = await modelState(page);
  expect(
    Buffer.from(opened.stepBytes ?? []).equals(Buffer.from(build.stepBytes)),
    "the app holds the geometry after the split, not the import",
  ).toBe(true);
  expect(padNodes(opened, "left")).toEqual(opened.groups[0].nodeIds);
  expect(padNodes(opened, "right")).toEqual(opened.groups[1].nodeIds);

  // Re-mesh finer, as a user would in the Mesh panel.
  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill(String(REMESH));
  await page.getByTestId("min-element-size").fill(String(REMESH / 10));
  await page.getByRole("button", { name: /Re-mesh STEP volume/ }).click();
  await expect
    .poll(
      async () => {
        const st = await modelState(page);
        return !st.isMeshing && st.nodes.length !== opened.nodes.length;
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  await expect(page.getByTestId("meshing-error")).toHaveCount(0);

  const remeshed = await modelState(page);
  expect(remeshed.remeshNotice, "both groups kept, none cleared").toBe(
    "Kept 2 support/load/tie groups on their CAD faces.",
  );
  expect(remeshed.groups.map((g) => [g.name, g.cadFaceIds])).toEqual(
    opened.groups.map((g) => [g.name, g.cadFaceIds]),
  );
  // Each group sits on its own piece of the bottom face, the whole piece and
  // nothing else, on the new mesh.
  const [support, load] = remeshed.groups;
  expect(support.nodeIds.length).toBeGreaterThan(0);
  expect(support.nodeIds, "support on the left pad").toEqual(
    padNodes(remeshed, "left"),
  );
  expect(load.nodeIds, "load on the right pad").toEqual(
    padNodes(remeshed, "right"),
  );
});

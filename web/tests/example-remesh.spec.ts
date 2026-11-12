// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// An opened example re-meshes with every support and load on the same CAD
// faces (KOF-322): every published example, and a throwaway whose recipe
// splits the imported geometry.
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
import {
  asRecipe,
  groupFaces,
  snapshot,
  type Recipe,
  type Snapshot,
} from "./fixtures/recipe";
import { ORDER, showcaseRecipe } from "../../examples/validation/catalog.mjs";
import cases from "../../examples/validation/cases/index.mjs";

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

// ── Every published example ──────────────────────────────────────────────────

// An example's own recipe (its case module, or examples/gallery/recipes/).
function exampleRecipe(id: string): Recipe {
  const mod = (cases as { id: string; recipe?: unknown }[]).find(
    (c) => c.id === id,
  );
  const raw: unknown = mod ? mod.recipe : showcaseRecipe(id);
  if (raw === undefined) throw new Error(`example "${id}" has no recipe`);
  return asRecipe(id, raw);
}

// Every support and load entry: its CAD face, and whether its nodes are
// exactly that face's nodes on the current mesh (an Edge entry: the face's
// rim on the shell).
function groupEntries(snap: Snapshot) {
  return [...snap.bcGroups, ...snap.loadGroups].map((group) =>
    groupFaces(snap, group.faces),
  );
}

function storeFlags(page: Page) {
  return page.evaluate(() => {
    const st = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            stepBytes: Uint8Array | null;
            stepSurface: { triangles: unknown[] } | null;
            isMeshing: boolean;
            nodes: unknown[];
            remeshNotice: string | null;
          };
        };
      }
    ).__kofemStore.getState();
    return {
      stepBytes: st.stepBytes?.length ?? 0,
      stepTriangles: st.stepSurface?.triangles.length ?? 0,
      isMeshing: st.isMeshing,
      nodes: st.nodes.length,
      remeshNotice: st.remeshNotice,
    };
  });
}

// Every example opens with its body drawn and its STEP file restored, and
// re-meshes with each support and load on the same CAD faces, on exactly that
// face's nodes of the new mesh. The re-mesh is twice the example's own element
// size: a genuinely different mesh, and quick (the shell plate's own 1 mm mesh
// takes about a minute).
for (const id of ORDER as string[]) {
  test(`${id} opens with its geometry and re-meshes with its groups on the same CAD faces`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const recipe = exampleRecipe(id);
    await page.goto(`/app/?example=${id}`);
    await expect(page.locator("nav")).toBeVisible();
    await expect
      .poll(async () => (await storeFlags(page)).stepBytes, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    const opened = await storeFlags(page);
    expect(opened.stepTriangles, "the body is drawn").toBeGreaterThan(0);
    expect(opened.nodes).toBeGreaterThan(0);

    const before = await snapshot(page);
    const entries = groupEntries(before);
    expect(entries.length).toBe(recipe.supports.length + recipe.loads.length);
    for (const faces of entries)
      for (const face of faces) {
        expect(face.cadFaceId, "a whole CAD face").not.toBeNull();
        expect(face.onMesh, "on the opened mesh").toBe(true);
      }

    const size = 2 * recipe.mesh.maxElementSize;
    await openTree(page, "mesh");
    await page.getByTestId("max-element-size").fill(String(size));
    await page.getByTestId("min-element-size").fill(String(size / 10));
    await page.getByRole("button", { name: /Re-mesh STEP volume/ }).click();
    await expect
      .poll(
        async () => {
          const st = await storeFlags(page);
          return !st.isMeshing && st.nodes !== opened.nodes;
        },
        { timeout: 180_000 },
      )
      .toBe(true);
    await expect(page.getByTestId("meshing-error")).toHaveCount(0);

    const groups = entries.length;
    expect((await storeFlags(page)).remeshNotice, "every group kept").toBe(
      `Kept ${groups} support/load/tie group${groups === 1 ? "" : "s"} on their CAD faces.`,
    );
    const after = groupEntries(await snapshot(page));
    expect(after.map((faces) => faces.map((f) => f.cadFaceId))).toEqual(
      entries.map((faces) => faces.map((f) => f.cadFaceId)),
    );
    for (const faces of after)
      for (const face of faces)
        expect(face.onMesh, `CAD face ${face.cadFaceId} on the new mesh`).toBe(
          true,
        );
  });
}

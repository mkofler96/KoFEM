// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The MBB beam gallery example, built by hand: every step a user takes, through
// the UI, with real clicks on the faces — the recipe in
// examples/gallery/generate-mbb-topopt.mjs. It proves two things:
//
//   1. the example is something a user can make: from a plain block, the split
//      tool carves the pads, the pick panels put the supports and the load on
//      them, and the result is the very model the gallery ships (same CAD
//      faces, same supports, same load);
//   2. a finer re-mesh keeps the supports and the load — they sit on CAD faces,
//      not on the old mesh's nodes.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import {
  clickModelAt,
  geometryCounts,
  importStepText,
  lookFrom,
  splitFaceAt,
} from "./fixtures/split";
import { prismStep } from "../../examples/gallery/step-prism.mjs";

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
const FROM_BELOW: [number, number, number] = [0.3, -1, 0.6];
const FROM_ABOVE: [number, number, number] = [0.3, 1, 0.6];

interface GroupSummary {
  name: string;
  dofs?: number[];
  components?: number[];
  // `onMesh`: the entry's nodes are exactly the current mesh's nodes of its
  // CAD face — what a fresh pick of that face would give.
  faces: { cadFaceId?: number; nodes: number; onMesh: boolean }[];
}

function readModel(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            nodes: unknown[];
            bcGroups: {
              name: string;
              dofs: number[];
              faces: { cadFaceId?: number; nodeIds: number[] }[];
            }[];
            loadGroups: {
              name: string;
              components?: number[];
              faces: { cadFaceId?: number; nodeIds: number[] }[];
            }[];
            surfaceLoads: unknown[];
            remeshNotice: string | null;
            surfaceTriangles: [number, number, number][] | null;
            surfaceFaceIds: number[] | null;
          };
        };
      }
    ).__kofemStore.getState();
    const nodesOfFace = (id: number | undefined) => {
      const set = new Set<number>();
      state.surfaceTriangles?.forEach((tri, t) => {
        if (state.surfaceFaceIds?.[t] === id) tri.forEach((n) => set.add(n));
      });
      return [...set].sort((a, b) => a - b).join(",");
    };
    const faces = (list: { cadFaceId?: number; nodeIds: number[] }[]) =>
      list.map((f) => ({
        cadFaceId: f.cadFaceId,
        nodes: f.nodeIds.length,
        onMesh:
          [...f.nodeIds].sort((a, b) => a - b).join(",") ===
          nodesOfFace(f.cadFaceId),
      }));
    return {
      nodes: state.nodes.length,
      bc: state.bcGroups.map((g) => ({
        name: g.name,
        dofs: g.dofs,
        faces: faces(g.faces),
      })) as GroupSummary[],
      load: state.loadGroups.map((g) => ({
        name: g.name,
        components: g.components,
        faces: faces(g.faces),
      })) as GroupSummary[],
      surfaceLoads: state.surfaceLoads.length,
      remeshNotice: state.remeshNotice,
    };
  });
}

async function mesh(page: Page, maxSize: string): Promise<void> {
  const before = (await readModel(page)).nodes;
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Geometry" })
    .click();
  await page.getByTestId("max-element-size").fill(maxSize);
  await page.getByTestId("min-element-size").fill(String(Number(maxSize) / 10));
  await page.getByRole("button", { name: /mesh STEP volume/i }).click();
  await expect
    .poll(async () => (await readModel(page)).nodes, { timeout: 120_000 })
    .not.toBe(before);
}

async function pickSupport(
  page: Page,
  at: [number, number, number],
  keep: string[],
): Promise<void> {
  await page.getByRole("button", { name: "Add BC" }).click();
  await lookFrom(page, FROM_BELOW);
  await clickModelAt(page, at);
  for (const dof of ["Ux", "Uy", "Uz"]) {
    const box = page.getByLabel(dof, { exact: true });
    if ((await box.isChecked()) !== keep.includes(dof)) await box.click();
  }
  await page.getByRole("button", { name: "Apply BC" }).click();
}

test("the MBB beam example can be built by hand, and survives a finer re-mesh", async ({
  page,
}) => {
  test.setTimeout(300_000);

  // ── Geometry: a plain block, four cuts ──────────────────────────────────────
  await importStepText(page, BLOCK);
  expect((await geometryCounts(page)).faces).toBe(6);
  await page.getByTestId("split-open").click();
  await lookFrom(page, FROM_BELOW);
  await splitFaceAt(page, [150, 0, 5], 5); // pin pad
  await splitFaceAt(page, [150, 0, 5], 295); // roller pad
  await lookFrom(page, FROM_ABOVE);
  await splitFaceAt(page, [100, 50, 5], 145);
  await splitFaceAt(page, [200, 50, 5], 155); // load pad
  expect(await geometryCounts(page)).toEqual({
    faces: 10,
    bodies: 1,
    edits: 4,
  });
  await page.getByRole("button", { name: "Close" }).click();

  // ── Mesh, supports, load ────────────────────────────────────────────────────
  await mesh(page, "5");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Constraints" })
    .click();
  await pickSupport(page, [2.5, 0, 5], ["Ux", "Uy", "Uz"]); // pin
  await pickSupport(page, [297.5, 0, 5], ["Uy"]); // roller

  await page.getByRole("button", { name: "Add Load" }).click();
  await lookFrom(page, FROM_ABOVE);
  await clickModelAt(page, [150, 50, 5]);
  await page.getByText("Fy (N)").locator("..").locator("input").fill("-1000");
  await page.getByRole("button", { name: "Apply Load" }).click();

  const built = await readModel(page);
  expect(built.bc.map((g) => g.dofs)).toEqual([[0, 1, 2], [1]]);
  expect(built.load).toHaveLength(1);
  expect(built.load[0].components).toEqual([0, -1000, 0]);
  expect(built.surfaceLoads).toBe(1);
  // Every pick was a whole CAD face — the pads the split made.
  const picked = [...built.bc, ...built.load].map((g) => g.faces[0]);
  for (const face of picked) {
    expect(face.cadFaceId).toBeDefined();
    expect(face.onMesh).toBe(true);
  }
  expect(new Set(picked.map((f) => f.cadFaceId)).size).toBe(3);

  // ── A finer mesh keeps them ─────────────────────────────────────────────────
  await mesh(page, "4");
  const finer = await readModel(page);
  expect(finer.nodes).toBeGreaterThan(built.nodes);
  expect(finer.bc.map((g) => g.dofs)).toEqual([[0, 1, 2], [1]]);
  expect(finer.load[0].components).toEqual([0, -1000, 0]);
  expect(finer.surfaceLoads).toBe(1);
  const finerPicked = [...finer.bc, ...finer.load].map((g) => g.faces[0]);
  expect(finerPicked.map((f) => f.cadFaceId)).toEqual(
    picked.map((f) => f.cadFaceId),
  );
  // Re-resolved, not kept: each entry holds the NEW mesh's nodes of its face.
  for (const face of finerPicked) expect(face.onMesh).toBe(true);
  await expect(page.getByTestId("remesh-notice")).toContainText(
    "Kept 3 support/load/tie groups on their CAD faces.",
  );

  // ── …and it is the model the gallery ships ──────────────────────────────────
  // Same split, same file, same CAD face numbering: the example's supports and
  // load sit on exactly the faces picked here. At the example's 5 mm mesh the
  // pads carry the same nodes as the hand-built 5 mm mesh did.
  await page.goto("/app/?example=mbb-beam-topopt");
  await expect
    .poll(async () => (await readModel(page)).nodes, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const shipped = await readModel(page);
  expect(shipped.bc.map((g) => g.dofs)).toEqual([[0, 1, 2], [1]]);
  expect(shipped.load[0].components).toEqual([0, -1000, 0]);
  expect([...shipped.bc, ...shipped.load].map((g) => g.faces[0])).toEqual(
    picked,
  );
});

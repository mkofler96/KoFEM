// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";

// End-to-end coverage for edge picking (#386): a flat shell sheet is one
// face-pick region, so grabbing its rim (an edge load or a supported-edge BC)
// needs the edge-pick mode. This drives the real UI on the shipped
// plate-with-hole shell example — the Face/Edge toggle, a real viewport click
// that routes through useFacePick → pickEdgeNodeIds → extractBoundaryEdges, and
// applying the resulting edge selection as both a BC and a load.

type PickState = {
  selectedFace: { nodeIds: number[]; label: string } | null;
  pickGeometry: "face" | "edge";
  bcGroups: { name: string; faces: { label: string; nodeIds: number[] }[] }[];
  loadGroups: { name: string; faces: { label: string }[] }[];
  nodes: unknown[];
};

function readPickState(page: Page) {
  return page.evaluate(() => {
    const state = (
      window as unknown as { __kofemStore: { getState(): PickState } }
    ).__kofemStore.getState();
    return {
      selected: state.selectedFace
        ? {
            nodeIds: state.selectedFace.nodeIds,
            label: state.selectedFace.label,
          }
        : null,
      pickGeometry: state.pickGeometry,
      bcGroups: state.bcGroups.map((g) => ({
        name: g.name,
        faces: g.faces.map((f) => ({
          label: f.label,
          count: f.nodeIds.length,
        })),
      })),
      loadGroups: state.loadGroups.map((g) => ({
        name: g.name,
        faces: g.faces.map((f) => ({ label: f.label })),
      })),
      nodeCount: state.nodes.length,
    };
  });
}

// Click across the viewport until a boundary polyline is picked. Any hit on the
// flat plate resolves to the boundary edge nearest the hit point, so a handful
// of spread-out spots reliably lands one without depending on camera framing.
async function edgePickOnViewport(page: Page): Promise<void> {
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("viewport canvas has no bounding box");
  const spots: [number, number][] = [
    [0.3, 0.5],
    [0.7, 0.5],
    [0.5, 0.3],
    [0.5, 0.7],
    [0.35, 0.4],
    [0.65, 0.6],
  ];
  for (const [fx, fy] of spots) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    const picked = await page
      .evaluate(
        () =>
          ((
            window as unknown as {
              __kofemStore: {
                getState(): { selectedFace: { nodeIds: number[] } | null };
              };
            }
          ).__kofemStore.getState().selectedFace?.nodeIds.length ?? 0) > 0,
      )
      .catch(() => false);
    if (picked) return;
    await page.waitForTimeout(150);
  }
  throw new Error(
    "no boundary edge was picked after trying every viewport spot",
  );
}

test("edge picking a shell rim creates an edge BC and an edge load", async ({
  page,
}) => {
  test.setTimeout(90_000);

  await page.goto("/app/?example=plate-with-hole-shell");
  await expect(page.locator("nav")).toBeVisible();
  await page.waitForFunction(
    () => !!(window as unknown as { __kofem?: unknown }).__kofem,
  );
  await expect
    .poll(async () => (await readPickState(page)).nodeCount, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  const totalNodes = (await readPickState(page)).nodeCount;

  // The example opens in Results; move to Constraints where the BC/Load pickers
  // live (the nav tab drives setMode).
  await page.getByRole("button", { name: "Constraints" }).click();

  // ── Edge BC ──────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Add BC" }).click();

  // The Face/Edge toggle is offered because the model has shell elements.
  const edgeToggle = page.getByRole("button", { name: "Edge", exact: true });
  await expect(edgeToggle).toBeVisible();
  await edgeToggle.click();
  await expect(page.getByText("Pick edge — fixed displacement")).toBeVisible();

  await edgePickOnViewport(page);

  const afterBcPick = await readPickState(page);
  expect(afterBcPick.pickGeometry).toBe("edge");
  expect(afterBcPick.selected).not.toBeNull();
  expect(afterBcPick.selected!.label.startsWith("Edge")).toBe(true);
  // A rim is a small polyline — never the whole flat plate (the motivating bug).
  expect(afterBcPick.selected!.nodeIds.length).toBeGreaterThan(2);
  expect(afterBcPick.selected!.nodeIds.length).toBeLessThan(totalNodes * 0.5);

  await page.getByRole("button", { name: "Apply BC" }).click();
  const afterBc = await readPickState(page);
  expect(afterBc.bcGroups.length).toBeGreaterThan(0);
  const bcFace = afterBc.bcGroups[afterBc.bcGroups.length - 1].faces[0];
  expect(bcFace.label.startsWith("Edge")).toBe(true);
  expect(bcFace.count).toBeGreaterThan(2);

  // ── Edge load ────────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Add Load" }).click();
  await page.getByRole("button", { name: "Edge", exact: true }).click();

  await edgePickOnViewport(page);

  // A force on an edge is applied as a work-equivalent line load.
  await expect(page.getByText(/line load along the edge/)).toBeVisible();

  await page.getByRole("button", { name: "Apply Load" }).click();
  const afterLoad = await readPickState(page);
  expect(afterLoad.loadGroups.length).toBeGreaterThan(0);
  const loadFace =
    afterLoad.loadGroups[afterLoad.loadGroups.length - 1].faces[0];
  expect(loadFace.label.startsWith("Edge")).toBe(true);
});

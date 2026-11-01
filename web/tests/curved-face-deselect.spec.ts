// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { addBoundary } from "./fixtures/tree";
import { serveUnvalidatedExample } from "./fixtures/unvalidated-examples";

// KOF-211: a face pick with no CAD face behind it is grown by the flood fill,
// whose region depends on the clicked triangle. A second click on a selected
// curved region, away from the first, grew a different region, which was
// added instead of toggling the selection off. This drives the real viewport
// on the crane hook with its CAD face ids cleared (a mesh with no CAD faces,
// as after an .inp import), so every pick takes the flood-fill path.

type Store = {
  getState(): {
    nodes: { id: number; x: number; y: number; z: number }[];
    selectedFace: { nodeIds: number[] } | null;
    pendingFaces: { nodeIds: number[] }[];
    setSelectedFace(face: null): void;
    setPendingFaces(faces: []): void;
  };
  setState(partial: Record<string, unknown>): void;
};

type Viewport = {
  project(point: [number, number, number]): { x: number; y: number } | null;
};

// The current selection: how many regions, and for the last one whether it is
// curved (its nodes are not coplanar) and where its centroid lands on screen.
type SelectionShape = {
  regions: number;
  curved: boolean;
  centre: { x: number; y: number } | null;
};

function readSelection(page: Page): Promise<SelectionShape> {
  return page.evaluate(() => {
    const win = window as unknown as {
      __kofemStore: Store;
      __kofemViewport: Viewport;
    };
    const state = win.__kofemStore.getState();
    const regions =
      state.pendingFaces.length + (state.selectedFace === null ? 0 : 1);
    if (state.selectedFace === null)
      return { regions, curved: false, centre: null };
    const ids = new Set(state.selectedFace.nodeIds);
    const pts = state.nodes
      .filter((node) => ids.has(node.id))
      .map((node) => [node.x, node.y, node.z]);
    const centroid = [0, 1, 2].map(
      (axis) => pts.reduce((acc, pt) => acc + pt[axis], 0) / pts.length,
    ) as [number, number, number];
    // Plane through the first point and the two points farthest from it; a
    // curved band has nodes off that plane, a flat face does not.
    const sub = (pa: number[], pb: number[]) => pa.map((v, i) => v - pb[i]);
    const len = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
    const origin = pts[0];
    const far = pts.reduce((best, pt) =>
      len(sub(pt, origin)) > len(sub(best, origin)) ? pt : best,
    );
    const axisU = sub(far, origin);
    const cross = (pa: number[], pb: number[]) => [
      pa[1] * pb[2] - pa[2] * pb[1],
      pa[2] * pb[0] - pa[0] * pb[2],
      pa[0] * pb[1] - pa[1] * pb[0],
    ];
    const third = pts.reduce((best, pt) =>
      len(cross(axisU, sub(pt, origin))) > len(cross(axisU, sub(best, origin)))
        ? pt
        : best,
    );
    const normal = cross(axisU, sub(third, origin));
    const size = len(axisU);
    const offPlane = Math.max(
      ...pts.map(
        (pt) =>
          Math.abs(
            sub(pt, origin).reduce((acc, v, i) => acc + v * normal[i], 0),
          ) / len(normal),
      ),
    );
    return {
      regions,
      curved: offPlane > 1e-3 * size,
      centre: win.__kofemViewport.project(centroid),
    };
  });
}

test("clicking inside a selected curved region deselects it (KOF-211)", async ({
  page,
}) => {
  test.setTimeout(300_000);

  await serveUnvalidatedExample(page, "full-crane-hook");
  await page.goto("/app/?example=full-crane-hook");
  await expect(page.locator("nav")).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as { __kofemStore: Store }
            ).__kofemStore.getState().nodes.length,
        ),
      { timeout: 90_000 },
    )
    .toBeGreaterThan(0);

  await addBoundary(page, "bc");
  await page.evaluate(() => {
    (window as unknown as { __kofemStore: Store }).__kofemStore.setState({
      surfaceFaceIds: null,
    });
  });

  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("viewport canvas has no bounding box");

  // Find a click that selects a curved region, clearing flat ones.
  let first: SelectionShape | null = null;
  for (let fy = 0.92; fy >= 0.3 && !first; fy -= 0.02) {
    for (let fx = 0.3; fx <= 0.7 && !first; fx += 0.02) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      const hit = await readSelection(page);
      if (hit.regions === 0) continue;
      if (hit.curved) {
        first = hit;
        continue;
      }
      await page.evaluate(() => {
        const store = (
          window as unknown as { __kofemStore: Store }
        ).__kofemStore.getState();
        store.setSelectedFace(null);
        store.setPendingFaces([]);
      });
    }
  }
  if (!first) throw new Error("no click on the viewport hit a curved surface");
  expect(first.regions).toBe(1);
  if (!first.centre)
    throw new Error("the selected region is behind the camera");
  await page.screenshot({ path: test.info().outputPath("1-selected.png") });

  // A second click inside the selected region, at its centroid on screen: a
  // different triangle from the first click, so its flood fill grows a
  // different region.
  await page.mouse.click(first.centre.x, first.centre.y);
  const second = await readSelection(page);
  await page.screenshot({ path: test.info().outputPath("2-second-click.png") });
  expect(second.regions).toBe(0);
});

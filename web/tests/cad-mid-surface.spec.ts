// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-498: meshing a plate marked Shell in the app takes the CAD mid-surface
// path. The engine pairs the plate's two faces and meshes only the mid-surface,
// so the stored model is shell facets alone — no tetrahedra — halfway through
// the plate, with the upper face as the top side, and the store keeps the
// links from every facet and rim edge back to the CAD faces, and the body's
// route.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { prismStep } from "../../examples/gallery/step-prism.mjs";
import { gotoApp } from "./fixtures/app";
import { openTree, setElementType } from "./fixtures/tree";

const THICKNESS = 10; // mm
const cos30 = Math.cos(Math.PI / 6);
const sin30 = Math.sin(Math.PI / 6);
// NAFEMS LE6: the 30° skew plate of examples/validation, 1 m sides.
const LE6 = Buffer.from(
  prismStep(
    [
      [0, 0],
      [1000, 0],
      [1000 * (1 + cos30), 1000 * sin30],
      [1000 * cos30, 1000 * sin30],
    ],
    THICKNESS,
    "NAFEMS LE6 skew plate",
  ),
);

interface StoredShell {
  elementTypes: string[];
  facetCount: number;
  linkedFacets: number;
  rimSideFaces: number[];
  routes: { body: number; path: string }[];
  worstOffMidPlane: number;
  downwardFacets: number;
  topFaces: number[];
}

function storedShell(page: Page): Promise<StoredShell> {
  return page.evaluate((thickness) => {
    type Node = { id: number; x: number; y: number; z: number };
    type Element = { type: string; nodeIds: number[] };
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            nodes: Node[];
            elements: Element[];
            midSurfaceLinks: {
              facets: { element: number; top: number }[];
              rim: { sideFace: number }[];
            } | null;
            shellRoutes: { body: number; path: string }[];
          };
        };
      }
    ).__kofemStore.getState();
    const byId = new Map(state.nodes.map((n) => [n.id, n]));
    let downward = 0;
    for (const element of state.elements) {
      const [a, b, c] = element.nodeIds.map((id) => byId.get(id) as Node);
      const normalZ = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (normalZ <= 0) downward++;
    }
    const links = state.midSurfaceLinks;
    return {
      elementTypes: [...new Set(state.elements.map((e) => e.type))],
      facetCount: state.elements.length,
      linkedFacets: links?.facets.length ?? 0,
      rimSideFaces: [...new Set(links?.rim.map((r) => r.sideFace) ?? [])],
      routes: state.shellRoutes.map(({ body, path }) => ({ body, path })),
      worstOffMidPlane: Math.max(
        ...state.nodes.map((n) => Math.abs(n.z - thickness / 2)),
      ),
      downwardFacets: downward,
      topFaces: [...new Set(links?.facets.map((f) => f.top) ?? [])],
    };
  }, THICKNESS);
}

test("a plate marked Shell is meshed as its CAD mid-surface, without a volume mesh @pipeline", async ({
  page,
}) => {
  const logs: string[] = [];
  page.on("console", (msg) => logs.push(msg.text()));

  await gotoApp(page);
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles({
    name: "le6.step",
    mimeType: "application/octet-stream",
    buffer: LE6,
  });
  await expect(
    page.getByRole("button", { name: /Generate mesh/ }),
  ).toBeVisible();
  await setElementType(page, 1, "shell");
  await openTree(page, "mesh");
  await page.getByRole("button", { name: /Generate mesh/ }).click();
  await expect(page.getByTestId("mesh-summary")).toBeVisible();

  const shell = await storedShell(page);
  expect(shell.elementTypes).toEqual(["CTRIA3"]);
  expect(shell.linkedFacets).toBe(shell.facetCount);
  expect(shell.routes).toEqual([{ body: 1, path: "cad" }]);
  expect(shell.rimSideFaces).toHaveLength(4);
  expect(shell.topFaces).toHaveLength(1);
  expect(shell.worstOffMidPlane).toBeLessThan(1e-9);
  expect(shell.downwardFacets).toBe(0);
  expect(logs.some((line) => line.includes("CAD mid-surface"))).toBe(true);
  expect(logs.some((line) => line.includes("step 4/4"))).toBe(false);
});

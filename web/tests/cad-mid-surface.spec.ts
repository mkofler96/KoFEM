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
import {
  addBoundary,
  openBody,
  openTree,
  setElementType,
} from "./fixtures/tree";
import { clickModelAt, lookFrom } from "./fixtures/viewport";

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

async function meshAsShell(page: Page, step: Buffer = LE6): Promise<void> {
  await gotoApp(page);
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles({
    name: "part.step",
    mimeType: "application/octet-stream",
    buffer: step,
  });
  await expect(
    page.getByRole("button", { name: /Generate mesh/ }),
  ).toBeVisible();
  await setElementType(page, 1, "shell");
  await openTree(page, "mesh");
  await page.getByRole("button", { name: /Generate mesh/ }).click();
  await expect(page.getByTestId("mesh-summary")).toBeVisible();
}

interface PickedCad {
  selected: { cadFaceId?: number; label: string } | null;
  top: number;
  bottom: number;
  // Of the newest surface load: the z component of each facet's normal.
  loadNormalsZ: number[];
}

function pickedCad(page: Page): Promise<PickedCad> {
  return page.evaluate(() => {
    type Node = { id: number; x: number; y: number; z: number };
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            nodes: Node[];
            selectedFace: { cadFaceId?: number; label: string } | null;
            midSurfaceLinks: { facets: { top: number; bottom: number }[] };
            surfaceLoads: { faces: number[][] }[];
          };
        };
      }
    ).__kofemStore.getState();
    const byId = new Map(state.nodes.map((n) => [n.id, n]));
    const last = state.surfaceLoads.at(-1);
    return {
      selected: state.selectedFace
        ? {
            cadFaceId: state.selectedFace.cadFaceId,
            label: state.selectedFace.label,
          }
        : null,
      top: state.midSurfaceLinks.facets[0].top,
      bottom: state.midSurfaceLinks.facets[0].bottom,
      loadNormalsZ: (last?.faces ?? []).map((face) => {
        const [a, b, c] = face.map((id) => byId.get(id) as Node);
        return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
      }),
    };
  });
}

const CENTRE: [number, number] = [(1000 * (1 + cos30)) / 2, (1000 * sin30) / 2];

test("supports and loads on a CAD mid-surface are picked on its CAD faces @pipeline", async ({
  page,
}) => {
  await meshAsShell(page);
  await expect(page.getByTestId("mesh-summary")).toBeVisible();

  // From above, a click on the see-through plate selects its upper face.
  await addBoundary(page, "load");
  await lookFrom(page, [0, 0, 1]);
  await clickModelAt(page, [CENTRE[0], CENTRE[1], THICKNESS]);
  const fromAbove = await pickedCad(page);
  expect(fromAbove.selected?.cadFaceId).toBe(fromAbove.top);
  await page.getByRole("button", { name: "Apply Load" }).click();
  const upper = await pickedCad(page);
  expect(upper.loadNormalsZ.length).toBeGreaterThan(0);
  expect(upper.loadNormalsZ.every((z) => z > 0)).toBe(true);

  // From below, the same spot is the lower face, whose load acts on the
  // facets wound the other way.
  await addBoundary(page, "load");
  await lookFrom(page, [0, 0, -1]);
  await clickModelAt(page, [CENTRE[0], CENTRE[1], 0]);
  const fromBelow = await pickedCad(page);
  expect(fromBelow.selected?.cadFaceId).toBe(fromBelow.bottom);
  await page.getByRole("button", { name: "Apply Load" }).click();
  const lower = await pickedCad(page);
  expect(lower.loadNormalsZ.length).toBe(upper.loadNormalsZ.length);
  expect(lower.loadNormalsZ.every((z) => z < 0)).toBe(true);

  // In Edge mode, a click on a side face selects the rim it collapsed to.
  await addBoundary(page, "bc");
  await page.getByRole("button", { name: "Edge", exact: true }).click();
  await lookFrom(page, [0, -1, 0.3]);
  await clickModelAt(page, [500, 0, THICKNESS / 2]);
  const side = await pickedCad(page);
  expect(side.selected?.label.startsWith("Edge")).toBe(true);
  expect(side.selected?.cadFaceId).toBeDefined();
  expect([side.top, side.bottom]).not.toContain(side.selected?.cadFaceId);
});

test("an example saved with a CAD mid-surface opens with its links @pipeline", async ({
  page,
}) => {
  await page.goto("/app/?example=plate-with-hole-shell");
  await expect(page.locator("nav")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = (
          window as unknown as {
            __kofemStore: {
              getState(): {
                midSurfaceLinks: { facets: unknown[] } | null;
                shellRoutes: { path: string }[];
                elements: unknown[];
              };
            };
          }
        ).__kofemStore.getState();
        return {
          linked:
            state.midSurfaceLinks?.facets.length === state.elements.length,
          routes: state.shellRoutes.map((r) => r.path),
        };
      }),
    )
    .toEqual({ linked: true, routes: ["cad"] });
});

const L_BRACKET = Buffer.from(
  prismStep(
    [
      [0, 0],
      [100, 0],
      [100, 5],
      [5, 5],
      [5, 100],
      [0, 100],
    ],
    100,
    "L-bracket",
  ),
);

test("the body panel says a Shell body's mid-surface came from its CAD faces @pipeline", async ({
  page,
}) => {
  await meshAsShell(page);
  await openBody(page, 1);
  await expect(page.getByTestId("body-shell-route-1")).toHaveText(
    "Mid-surface from the CAD faces: 1 wall, 10 mm.",
  );
});

test("the body panel says why a Shell body's mid-surface came from its volume mesh @pipeline", async ({
  page,
}) => {
  // An L-bracket's two walls meet at a junction stage 1 does not pair.
  await meshAsShell(page, L_BRACKET);
  await openBody(page, 1);
  await expect(page.getByTestId("body-shell-route-1")).toHaveText(
    /^Mid-surface from the volume mesh, because face \d+ /,
  );
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from "fs";
import os from "os";
import path from "path";
import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";

// The first simulation a newcomer runs (KOF-261): the empty workspace offers
// the sample, the wall bracket's CAD file. The guide then walks them through
// mesh, supports, load and run, marking the faces to pick; here every step is
// taken through the UI with real clicks on the faces. The cantilever gallery
// example below carries a hand check of its result.

type Page = import("@playwright/test").Page;

function readModel(page: Page) {
  return page.evaluate(() => {
    const st = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            modelName: string;
            mode: string;
            result: unknown;
            elementOrder: number;
            handCheck: unknown;
          };
        };
      }
    ).__kofemStore.getState();
    return {
      modelName: st.modelName,
      mode: st.mode,
      hasResult: st.result !== null,
      elementOrder: st.elementOrder,
      hasHandCheck: st.handCheck !== null,
    };
  });
}

// CAD faces in the current pick (the panel's list of picked faces).
function pickedCadFaces(page: Page): Promise<(number | undefined)[]> {
  return page.evaluate(() => {
    type Face = { cadFaceId?: number };
    const st = (
      window as unknown as {
        __kofemStore: {
          getState(): { pendingFaces: Face[]; selectedFace: Face | null };
        };
      }
    ).__kofemStore.getState();
    const faces = st.selectedFace
      ? [...st.pendingFaces, st.selectedFace]
      : st.pendingFaces;
    return faces.map((f) => f.cadFaceId);
  });
}

// Click CAD face `id` in the viewport, as a user clicks a highlighted face:
// try points of it on screen (its mesh triangles' centres, clear of the guide)
// until the click picks it. A point where another face is in front picks that
// one instead, and a second click there takes it back out.
async function clickCadFace(page: Page, id: number): Promise<void> {
  const points = await page.evaluate((face) => {
    type Point = [number, number, number];
    const win = window as unknown as {
      __kofemStore: {
        getState(): {
          nodes: { id: number; x: number; y: number; z: number }[];
          surfaceTriangles: [number, number, number][];
          surfaceFaceIds: number[];
        };
      };
      __kofemViewport: { project(p: Point): { x: number; y: number } | null };
    };
    const st = win.__kofemStore.getState();
    const pos = new Map(st.nodes.map((n) => [n.id, n]));
    const canvas = document.querySelector("canvas")!.getBoundingClientRect();
    const guide = document
      .querySelector("[data-testid=sample-guide]")
      ?.getBoundingClientRect();
    const inside = (r: DOMRect, x: number, y: number, pad: number) =>
      x > r.left - pad &&
      x < r.right + pad &&
      y > r.top - pad &&
      y < r.bottom + pad;
    const out: { x: number; y: number }[] = [];
    st.surfaceTriangles.forEach((tri, t) => {
      if (st.surfaceFaceIds[t] !== face) return;
      const centre = [0, 0, 0] as Point;
      for (const nodeId of tri) {
        const node = pos.get(nodeId)!;
        centre[0] += node.x / 3;
        centre[1] += node.y / 3;
        centre[2] += node.z / 3;
      }
      const screen = win.__kofemViewport.project(centre);
      if (!screen || !inside(canvas, screen.x, screen.y, -5)) return;
      if (guide && inside(guide, screen.x, screen.y, 5)) return;
      out.push(screen);
    });
    return out;
  }, id);
  const stride = Math.max(1, Math.floor(points.length / 40));
  for (let i = 0; i < points.length; i += stride) {
    const before = (await pickedCadFaces(page)).join();
    await page.mouse.click(points[i].x, points[i].y);
    const after = await pickedCadFaces(page);
    if (after.includes(id)) return;
    if (after.join() !== before)
      await page.mouse.click(points[i].x, points[i].y);
  }
  throw new Error(`CAD face ${id} could not be clicked in the viewport`);
}

const guideAt = (page: Page, step: string) =>
  page.locator(`[data-testid=sample-guide][data-step=${step}]`);

test("a newcomer takes the CAD sample from mesh to result with the guide", async ({
  page,
}) => {
  test.setTimeout(240_000);

  await gotoApp(page);
  const start = Date.now();

  // Nothing loaded: the viewport offers the sample.
  const emptyState = page.getByTestId("empty-state");
  await expect(emptyState).toBeVisible();
  await page.getByRole("button", { name: "Try a sample simulation" }).click();

  // It opens as CAD geometry only, with nothing set up, on the mesh controls.
  await expect(guideAt(page, "mesh")).toBeVisible({ timeout: 30_000 });
  await expect(emptyState).toBeHidden();
  const opened = await page.evaluate(() => {
    const st = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            stepSurface: unknown;
            nodes: unknown[];
            bcGroups: unknown[];
            loadGroups: unknown[];
            studies: unknown[];
          };
        };
      }
    ).__kofemStore.getState();
    return {
      geometry: st.stepSurface !== null,
      nodes: st.nodes.length,
      boundary: st.bcGroups.length + st.loadGroups.length,
      studies: st.studies.length,
    };
  });
  expect(opened).toEqual({ geometry: true, nodes: 0, boundary: 0, studies: 0 });

  // 1. Mesh, from the panel the import opened.
  await page.getByRole("button", { name: /Mesh STEP volume/ }).click();
  await expect(guideAt(page, "support")).toBeVisible({ timeout: 120_000 });

  // 2. The guide's shortcut starts a support; the user clicks the three
  //    highlighted bolt holes and applies it.
  await page.getByTestId("sample-guide-action").click();
  for (const hole of [34, 35, 36]) await clickCadFace(page, hole);
  await page.getByRole("button", { name: "Apply BC" }).click();
  await expect(guideAt(page, "load")).toBeVisible();

  // 3. A load on the highlighted bore, Fy as the guide says.
  await expect(page.getByTestId("sample-guide")).toContainText("Fy = −2000 N");
  await page.getByTestId("sample-guide-action").click();
  await clickCadFace(page, 37);
  await page.getByText("Fy (N)").locator("..").locator("input").fill("-2000");
  await page.getByRole("button", { name: "Apply Load" }).click();
  await expect(guideAt(page, "run")).toBeVisible();

  // 4. The shortcut adds the static study; Run solves it.
  await page.getByTestId("sample-guide-action").click();
  await page.getByRole("button", { name: /Run static solve/ }).click();
  await expect(guideAt(page, "done")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId("sample-guide-done")).toBeVisible();
  const model = await readModel(page);
  expect(model.mode).toBe("results");
  expect(model.hasResult).toBe(true);

  // The issue's target is a human under two minutes; the scripted path,
  // meshing and solving included, has to be well inside it.
  const seconds = (Date.now() - start) / 1000;
  console.log(`[first-simulation] guided sample in ${seconds.toFixed(1)} s`);
  expect(seconds).toBeLessThan(120);

  // Closing the guide takes it away for good.
  await page.getByRole("button", { name: "Close the guide" }).click();
  await expect(page.getByTestId("sample-guide")).toHaveCount(0);
});

test("the guide goes away when another model replaces the sample", async ({
  page,
}) => {
  test.setTimeout(60_000);

  await gotoApp(page);
  await page.getByRole("button", { name: "Try a sample simulation" }).click();
  await expect(guideAt(page, "mesh")).toBeVisible({ timeout: 30_000 });

  // The user's own part, imported over it.
  await page.getByTestId("tree-add-geometry").click();
  await page
    .locator('input[type="file"][accept=".stp,.step"]')
    .setInputFiles(path.resolve("..", "test_files", "two_boxes.stp"));
  await expect(page.getByTestId("sample-guide")).toHaveCount(0, {
    timeout: 30_000,
  });
});

test("the hand check is withheld once the load no longer matches it", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto("/app/?example=cantilever-beam");
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled({ timeout: 15_000 });
  await run.click();
  await expect(page.getByTestId("hand-check-fe")).toBeVisible({
    timeout: 90_000,
  });

  // Twice the load, solved again: the formula's 10 kN no longer describes the
  // model.
  await page.evaluate(() =>
    (
      window as unknown as {
        __kofemStore: {
          getState(): {
            updateLoadGroup(
              id: number,
              kind: "force",
              totalForce: number,
              components: [number, number, number],
            ): void;
          };
        };
      }
    ).__kofemStore
      .getState()
      .updateLoadGroup(1, "force", -20000, [0, -20000, 0]),
  );
  await page.getByTestId("tree-study-1").click();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("hand-check")).toContainText(
    "no longer applies",
    { timeout: 90_000 },
  );
  await expect(page.getByTestId("hand-check-fe")).toHaveCount(0);
});

test("a saved cantilever keeps its element order and hand check", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kofem-cantilever-"));

  await page.goto("/app/?example=cantilever-beam");
  await expect(
    page.getByRole("button", { name: /Run static solve/ }),
  ).toBeEnabled({ timeout: 15_000 });

  const file = path.join(tmpDir, "cantilever.vtu");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save analysis" }).click();
  await (await download).saveAs(file);

  // Reopened in a fresh session: still quadratic, still checked.
  await gotoApp(page);
  await page.locator('input[type="file"][accept=".vtu"]').setInputFiles(file);
  await expect
    .poll(async () => (await readModel(page)).modelName, { timeout: 15_000 })
    .toBe("Cantilever beam under tip load");
  const model = await readModel(page);
  expect(model.elementOrder).toBe(2);
  expect(model.hasHandCheck).toBe(true);
});

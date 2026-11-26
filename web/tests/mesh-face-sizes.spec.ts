// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-394: in the Mesh step the user picks CAD faces and gives them an element
// size of their own. Netgen meshes those faces at that size and grades out to
// the body size; the size shows in the mesh summary, survives a re-mesh, and is
// saved in and loaded from the analysis file.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import fs from "fs";
import os from "os";
import path from "path";
import { gotoApp } from "./fixtures/app";
import { importStepText } from "./fixtures/split";
import { openTree } from "./fixtures/tree";
import { clickModelAt, lookFrom } from "./fixtures/viewport";
import { quarterStripWithHoleStep } from "../../examples/gallery/step-prism.mjs";

// The plate-with-hole example's quarter strip, 5 mm thick so the hole face is
// big enough to click and is not already refined along a thin plate's edge.
const HOLE_RADIUS = 10;
const THICKNESS = 5;
const STRIP = quarterStripWithHoleStep(
  HOLE_RADIUS,
  50,
  150,
  THICKNESS,
  "Quarter strip with a hole",
);
const ON_HOLE: [number, number, number] = [
  HOLE_RADIUS * Math.SQRT1_2,
  HOLE_RADIUS * Math.SQRT1_2,
  THICKNESS / 2,
];
// From the hole's side: its concave face looks towards −x, −y.
const INTO_HOLE: [number, number, number] = [-1, -1, 0.8];

// The mesh as the summary sees it, and the mean edge length of the surface
// elements on CAD face `face`.
function readMesh(page: Page, face: number) {
  return page.evaluate((faceId) => {
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            nodes: { id: number; x: number; y: number; z: number }[];
            elements: unknown[];
            surfaceTriangles: [number, number, number][] | null;
            surfaceFaceIds: number[] | null;
          };
        };
      }
    ).__kofemStore.getState();
    const byId = new Map(state.nodes.map((n) => [n.id, n]));
    let sum = 0;
    let count = 0;
    state.surfaceTriangles?.forEach((tri, t) => {
      if (state.surfaceFaceIds?.[t] !== faceId) return;
      for (let k = 0; k < 3; k++) {
        const from = byId.get(tri[k]);
        const to = byId.get(tri[(k + 1) % 3]);
        if (!from || !to) throw new Error("surface triangle off the mesh");
        sum += Math.hypot(from.x - to.x, from.y - to.y, from.z - to.z);
        count++;
      }
    });
    return {
      elements: state.elements.length,
      holeEdge: count > 0 ? sum / count : null,
    };
  }, face);
}

function faceSizeIds(page: Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: {
            getState(): { faceSizes: { faceIds: number[]; size: string }[] };
          };
        }
      ).__kofemStore.getState().faceSizes,
  );
}

async function generate(page: Page): Promise<void> {
  const before = (await readMesh(page, 0)).elements;
  await page.getByTestId("mesh-generate").click();
  await expect
    .poll(async () => (await readMesh(page, 0)).elements)
    .not.toBe(before);
  await expect(page.getByTestId("mesh-generate")).toBeEnabled();
}

async function saveAnalysis(page: Page, filePath: string): Promise<void> {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save analysis" }).click();
  await (await download).saveAs(filePath);
}

test("a face picked in the Mesh step meshes at its own size, and keeps it through a re-mesh and a save (KOF-394) @pipeline", async ({
  page,
}) => {
  await importStepText(page, STRIP);
  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill("5");
  await page.getByTestId("min-element-size").fill("0.1");

  // Without a face size: the reference mesh.
  await generate(page);

  // Pick the hole face and give it 0.5 mm.
  await page.getByTestId("face-size-pick").click();
  await lookFrom(page, INTO_HOLE);
  await clickModelAt(page, ON_HOLE);
  await expect(page.getByTestId("face-size-picked")).toHaveText(
    "1 face picked",
  );
  await page.getByTestId("face-size-input").fill("0.5");
  await page.getByTestId("face-size-add").click();
  const [entry] = await faceSizeIds(page);
  expect(entry).toEqual({ faceIds: [expect.any(Number)], size: "0.5" });
  const hole = entry.faceIds[0];
  const plain = await readMesh(page, hole);
  await expect(page.getByTestId("face-size-0")).toContainText("0.5");

  // The settings no longer match the mesh until it is regenerated.
  await expect(page.getByTestId("mesh-sizes-changed")).toBeVisible();
  await generate(page);
  await expect(page.getByTestId("mesh-sizes-changed")).toHaveCount(0);
  const sized = await readMesh(page, hole);
  console.log(
    `hole face mean edge: ${plain.holeEdge?.toFixed(3)} mm → ${sized.holeEdge?.toFixed(3)} mm; elements: ${plain.elements} → ${sized.elements}`,
  );
  expect(plain.holeEdge).toBeGreaterThan(1);
  expect(sized.holeEdge).toBeLessThan(0.7);
  expect(sized.elements).toBeGreaterThan(plain.elements);

  // The mesh summary lists the face size.
  await expect(page.getByTestId(`mesh-face-size-${hole}`)).toHaveText(
    "max 0.5 mm",
  );

  // A re-mesh keeps it.
  await page.getByTestId("max-element-size").fill("6");
  await generate(page);
  await expect(page.getByTestId(`mesh-face-size-${hole}`)).toHaveText(
    "max 0.5 mm",
  );
  expect((await readMesh(page, hole)).holeEdge).toBeLessThan(0.7);

  // Saved and loaded with the analysis.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kofem-face-sizes-"));
  const file = path.join(dir, "strip.vtu");
  await saveAnalysis(page, file);
  await gotoApp(page);
  await page
    .locator('input[type="file"][accept=".vtu,.zip"]')
    .setInputFiles(file);
  await openTree(page, "mesh");
  await expect(page.getByTestId(`mesh-face-size-${hole}`)).toHaveText(
    "max 0.5 mm",
  );
  expect(await faceSizeIds(page)).toEqual([{ faceIds: [hole], size: "0.5" }]);
  await expect(page.getByTestId("face-size-0")).toContainText("0.5");
});

test("removing the face size meshes as before (KOF-394) @pipeline", async ({
  page,
}) => {
  await importStepText(page, STRIP);
  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill("5");
  await page.getByTestId("min-element-size").fill("0.1");
  await generate(page);
  const plain = await readMesh(page, 0);

  await page.getByTestId("face-size-pick").click();
  await lookFrom(page, INTO_HOLE);
  await clickModelAt(page, ON_HOLE);
  await page.getByTestId("face-size-input").fill("0.5");
  await page.getByTestId("face-size-add").click();
  await generate(page);
  expect((await readMesh(page, 0)).elements).toBeGreaterThan(plain.elements);

  await page.getByTestId("face-size-remove-0").click();
  await expect(page.getByTestId("face-size-0")).toHaveCount(0);
  await expect(page.getByTestId("mesh-sizes-changed")).toBeVisible();
  await generate(page);
  expect((await readMesh(page, 0)).elements).toBe(plain.elements);
});

test("a face size that is not a positive number is refused when meshing (KOF-394) @pipeline", async ({
  page,
}) => {
  await importStepText(page, STRIP);
  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill("5");
  await page.getByTestId("min-element-size").fill("0.1");
  await page.getByTestId("face-size-pick").click();
  await lookFrom(page, INTO_HOLE);
  await clickModelAt(page, ON_HOLE);
  await page.getByTestId("face-size-input").fill("0");
  await page.getByTestId("face-size-add").click();
  await page.getByTestId("mesh-generate").click();
  await expect(page.getByTestId("meshing-error")).toContainText(
    "Face size 0 mm",
  );
});

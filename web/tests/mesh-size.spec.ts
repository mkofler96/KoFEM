// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-222: the mesh size fields used to clamp to [0.5, 500] mm on every
// keystroke and start at a fixed 20 mm, so a 1x1x1 mm cube could not be meshed
// at all — every legal setting was coarser than the part. The fields now accept
// any positive size, and a fresh import starts from a size computed for its own
// geometry.

import { test, expect } from "./coverage";
import { gotoApp, importStep } from "./fixtures/app";
import { fileURLToPath } from "url";

const STEP_FILE = fileURLToPath(
  new URL("./fixtures/tube.stp", import.meta.url),
);

const maxSize = "max-element-size";
const minSize = "min-element-size";

// Put the panel in the meshable state without paying for a real STEP import:
// a tessellated surface plus retained bytes is exactly what an import leaves
// behind, and it is what makes the mesh controls render.
async function fakeImport(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    (
      window as unknown as {
        __kofemStore: { setState(partial: Record<string, unknown>): void };
      }
    ).__kofemStore.setState({
      mode: "geometry",
      // A 1 mm cube, the part from the issue: two triangles per face.
      stepSurface: {
        points: [
          [0, 0, 0],
          [1, 0, 0],
          [1, 1, 0],
          [0, 1, 0],
          [0, 0, 1],
          [1, 0, 1],
          [1, 1, 1],
          [0, 1, 1],
        ],
        triangles: [
          [0, 2, 1],
          [0, 3, 2],
          [4, 5, 6],
          [4, 6, 7],
          [0, 1, 5],
          [0, 5, 4],
          [3, 7, 6],
          [3, 6, 2],
          [0, 4, 7],
          [0, 7, 3],
          [1, 2, 6],
          [1, 6, 5],
        ],
      },
      stepBytes: new Uint8Array([1, 2, 3]),
    });
  });
}

test("a sub-millimetre element size can be typed and kept (KOF-222)", async ({
  page,
}) => {
  await gotoApp(page);
  await fakeImport(page);

  // The old input clamped with Math.max(0.5, …) on change, so 0.05 became 0.5.
  await page.getByTestId(maxSize).fill("0.05");
  await expect(page.getByTestId(maxSize)).toHaveValue("0.05");
  await page.getByTestId(minSize).fill("0.005");
  await expect(page.getByTestId(minSize)).toHaveValue("0.005");

  // …and the old max attribute capped coarse meshes of large parts at 500 mm.
  await page.getByTestId(maxSize).fill("1200");
  await expect(page.getByTestId(maxSize)).toHaveValue("1200");
});

test("a fresh import starts from a size computed for its own geometry (KOF-222)", async ({
  page,
}) => {
  await gotoApp(page);
  await fakeImport(page);

  // The 1 mm cube must be sized far below the old 0.5 mm floor — and far below
  // the old fixed 20 mm default, which meshed it as a single element.
  const suggested = parseFloat(await page.getByTestId(maxSize).inputValue());
  expect(suggested).toBeGreaterThan(0);
  expect(suggested).toBeLessThan(0.5);
  expect(1 / suggested).toBeGreaterThan(10); // >10 elements across the cube

  const suggestedMin = parseFloat(await page.getByTestId(minSize).inputValue());
  expect(suggestedMin).toBeCloseTo(suggested / 10, 6);

  // The panel says what the model is and what the size will cost, so an
  // unbounded field is still an informed choice.
  await expect(page.getByTestId("geometry-extent")).toContainText(
    "1 × 1 × 1 mm",
  );
  await expect(page.getByTestId("geometry-extent")).toContainText("elements");
});

test("an unusable element size is refused with a specific message (KOF-222)", async ({
  page,
}) => {
  await gotoApp(page);
  await fakeImport(page);

  await page.getByTestId(maxSize).fill("0");
  await page.getByRole("button", { name: /Mesh STEP volume/ }).click();
  await expect(page.getByTestId("meshing-error")).toContainText(
    "Max element size must be a positive number",
  );

  // Min above max would silently invert the size field inside Netgen.
  await page.getByTestId(maxSize).fill("2");
  await page.getByTestId(minSize).fill("5");
  await page.getByRole("button", { name: /Mesh STEP volume/ }).click();
  await expect(page.getByTestId("meshing-error")).toContainText(
    "must not exceed max element size",
  );
});

test("the worker rejects a non-positive element size (KOF-222)", async ({
  page,
}) => {
  test.setTimeout(60_000);

  await page.goto("/app/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !!(window as Window & { __kofem?: unknown }).__kofem,
    { timeout: 30_000 },
  );

  const message = await page.evaluate(async () => {
    const kofem = (
      window as Window & {
        __kofem: { sendToWorker: (t: string, p: unknown) => Promise<unknown> };
      }
    ).__kofem;
    try {
      await kofem.sendToWorker("volume_mesh", { maxElementSize: 0 });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  });

  expect(message).toContain("max_element_size must be a positive number");
});

test("a real import is meshed at its suggested size (KOF-222)", async ({
  page,
}) => {
  test.setTimeout(300_000);

  await importStep(page, STEP_FILE);

  // The tube is ~40x40x60 mm; the old fixed default was 20 mm regardless.
  const suggested = parseFloat(await page.getByTestId(maxSize).inputValue());
  expect(suggested).toBeGreaterThan(0.5);
  expect(suggested).toBeLessThan(20);

  await page.getByRole("button", { name: /Mesh STEP volume/ }).click();
  const elements = await expect
    .poll(
      async () =>
        (await page.evaluate(
          () =>
            (
              window as unknown as {
                __kofemStore: { getState(): { elements: unknown[] } };
              }
            ).__kofemStore.getState().elements.length,
        )) as number,
      { timeout: 240_000 },
    )
    .toBeGreaterThan(0);
  void elements;

  // The suggestion aims at TARGET_ELEMENT_COUNT (50K). Netgen's actual density
  // varies with geometry, so assert the order of magnitude, not the number.
  const count = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: { getState(): { elements: unknown[] } };
        }
      ).__kofemStore.getState().elements.length,
  )) as number;
  expect(count).toBeGreaterThan(10_000);
  expect(count).toBeLessThan(250_000);
});

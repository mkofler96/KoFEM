// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Fit view frames the deformed shape (KOF-385). The cantilever beam
// (1000 × 100 × 100 mm, tip load down in y) drawn at a large deformation
// scale bends its tip far below the undeformed beam. After Fit view every
// vertex of the drawn result surface, and every node of the undeformed
// overlay drawn over it, lies inside the viewport: on a desktop screen and on
// a phone held upright, where the view is narrower than it is tall.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { drawnPositions, projectPoints, type Point } from "./fixtures/viewport";

function undeformedNodes(page: Page): Promise<Point[]> {
  return page.evaluate(() =>
    (
      window as unknown as {
        __kofemStore: {
          getState(): { nodes: { x: number; y: number; z: number }[] };
        };
      }
    ).__kofemStore
      .getState()
      .nodes.map(({ x, y, z }): [number, number, number] => [x, y, z]),
  );
}

// Solve the cantilever and draw it at factor 320, about three times the
// automatic one: the 1.9 mm tip deflection drawn about 610 mm down.
async function solveAtLargeScale(page: Page): Promise<void> {
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("colorbar")).toBeVisible();
  await page.getByLabel("Deformation factor").fill("320");
}

// After Fit view: the deformed shape and the undeformed overlay lie inside
// the viewport, and fill a good part of it.
async function expectDeformedShapeFramed(page: Page): Promise<void> {
  const flat = await drawnPositions(page, "result-surface");
  const deformed: Point[] = [];
  for (let i = 0; i < flat.length; i += 3)
    deformed.push([flat[i], flat[i + 1], flat[i + 2]]);
  // A large deflection: the tip is drawn more than five beam depths down.
  expect(Math.min(...deformed.map((p) => p[1]))).toBeLessThan(-500);

  const screen = await projectPoints(page, [
    ...deformed,
    ...(await undeformedNodes(page)),
  ]);
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("the viewport canvas is not on the page");
  const outside = screen.filter(
    (p) =>
      p === null ||
      p.x < box.x ||
      p.x > box.x + box.width ||
      p.y < box.y ||
      p.y > box.y + box.height,
  );
  expect(outside).toHaveLength(0);

  // Framed, not lost in the distance.
  const xs = screen.flatMap((p) => (p ? [p.x] : []));
  const ys = screen.flatMap((p) => (p ? [p.y] : []));
  const span = Math.max(
    (Math.max(...xs) - Math.min(...xs)) / box.width,
    (Math.max(...ys) - Math.min(...ys)) / box.height,
  );
  expect(span).toBeGreaterThan(0.5);
}

test("Fit view frames the deformed shape at a large deformation scale @pipeline", async ({
  page,
}) => {
  await page.goto("/app/?example=cantilever-beam");
  await solveAtLargeScale(page);
  await page.getByRole("button", { name: "Fit View" }).click();
  await expectDeformedShapeFramed(page);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Fit view frames the deformed shape in a view taller than wide @pipeline", async ({
    page,
  }) => {
    await page.goto("/app/?example=cantilever-beam");
    await page.getByRole("button", { name: "Show panel" }).click();
    await solveAtLargeScale(page);
    await page.getByRole("button", { name: "Hide panel" }).click();
    await page.getByRole("button", { name: "Fit View" }).click();
    await expectDeformedShapeFramed(page);
  });
});

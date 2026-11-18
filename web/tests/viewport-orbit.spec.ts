// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The view turns about the model point under the cursor and zooms toward it
// (KOF-345). Turning about the fixed orbit target made an off-centre face
// swing out of view, so reaching the face to load was hard.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { boxHexMesh } from "../../examples/validation/lib/mesh.mjs";
import {
  dragViewport,
  projectPoint,
  wheelViewportAt,
  type Point,
} from "./fixtures/viewport";

type Store = { setState(s: object): void };

// A 10 × 4 × 4 hex box, fitted into the view: the orbit target is its centre.
async function openBox(page: Page) {
  const mesh = boxHexMesh(10, 4, 4, 5, 2, 2);
  const nodes = mesh.vertices.map((v: number[], i: number) => ({
    id: i,
    x: v[0],
    y: v[1],
    z: v[2],
  }));
  const elements = mesh.hexahedra.map((h: number[], i: number) => ({
    id: i,
    type: "CHEXA",
    nodeIds: [...h],
    propertyId: 1,
  }));
  await page.goto("/app/");
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __kofemStore?: unknown }).__kofemStore),
  );
  await page.evaluate(
    (model) => {
      const store = (window as unknown as { __kofemStore: Store }).__kofemStore;
      store.setState({
        nodes: model.nodes,
        elements: model.elements,
        properties: [{ id: 1, materialId: 1 }],
        modelName: "Box",
        hasStarted: true,
        viewRepr: "surface",
      });
    },
    { nodes, elements },
  );
  await page.getByRole("button", { name: "Fit View" }).click();
}

// Within a pixel: the cursor sits on whole or half pixels, the projection
// does not.
function expectSamePixel(
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  expect(Math.abs(a.x - b.x)).toBeLessThan(1.5);
  expect(Math.abs(a.y - b.y)).toBeLessThan(1.5);
}

async function screenOf(page: Page, point: Point) {
  const at = await projectPoint(page, point);
  if (!at) throw new Error(`${point} is behind the camera`);
  return at;
}

// Near the x = 10 end of the top face, well away from the box centre.
const OFF_CENTRE: Point = [9, 4, 0.5];
const FAR_CORNER: Point = [0, 0, 4];

test("dragging turns the view about the point under the cursor", async ({
  page,
}) => {
  await openBox(page);
  const start = await screenOf(page, OFF_CENTRE);
  const cornerBefore = await screenOf(page, FAR_CORNER);

  await dragViewport(page, start, { x: start.x + 120, y: start.y + 60 });

  // The view turned...
  const cornerAfter = await screenOf(page, FAR_CORNER);
  expect(
    Math.hypot(cornerAfter.x - cornerBefore.x, cornerAfter.y - cornerBefore.y),
  ).toBeGreaterThan(20);
  // ...about the point the drag started on, which stayed where it was.
  const pivot = await screenOf(page, OFF_CENTRE);
  expectSamePixel(pivot, start);
});

test("a drag that starts off the model turns about the orbit target", async ({
  page,
}) => {
  await openBox(page);
  const canvas = await page.locator("canvas").first().boundingBox();
  if (!canvas) throw new Error("the viewport canvas is not on the page");
  const centre = await screenOf(page, [5, 2, 2]);
  expectSamePixel(centre, {
    x: canvas.x + canvas.width / 2,
    y: canvas.y + canvas.height / 2,
  });

  // Empty background near the left edge, halfway down.
  const start = { x: canvas.x + 30, y: canvas.y + canvas.height / 2 };
  await dragViewport(page, start, { x: start.x + 120, y: start.y + 60 });

  const after = await screenOf(page, [5, 2, 2]);
  expectSamePixel(after, centre);
});

test("the mouse wheel zooms toward the point under the cursor", async ({
  page,
}) => {
  await openBox(page);
  const at = await screenOf(page, OFF_CENTRE);
  const cornerBefore = await screenOf(page, FAR_CORNER);

  // Each notch zooms about 5 %.
  for (let notch = 0; notch < 4; notch++) await wheelViewportAt(page, at, -100);

  // Closer: the far corner moved away from the cursor on screen...
  const cornerAfter = await screenOf(page, FAR_CORNER);
  expect(
    Math.hypot(cornerAfter.x - at.x, cornerAfter.y - at.y),
  ).toBeGreaterThan(
    Math.hypot(cornerBefore.x - at.x, cornerBefore.y - at.y) * 1.1,
  );
  // ...and the point under the cursor stayed under it.
  const after = await screenOf(page, OFF_CENTRE);
  expectSamePixel(after, at);
});

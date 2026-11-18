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
  hoverViewport,
  projectPoint,
  touchViewport,
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

async function canvasBox(page: Page) {
  const canvas = await page.locator("canvas").first().boundingBox();
  if (!canvas) throw new Error("the viewport canvas is not on the page");
  return canvas;
}

// KOF-404: the drag turned the view only while the cursor was over the
// canvas, so one drag could not turn the view more than about a full circle.
test("a drag keeps turning the view after the cursor leaves the viewport", async ({
  page,
}) => {
  await openBox(page);
  const canvas = await canvasBox(page);
  const pageWidth = page.viewportSize()?.width;
  if (!pageWidth) throw new Error("the page has no viewport size");

  // A drag across the canvas height turns a full circle, so a drag of one and
  // a half heights turns 540°: half a turn about the vertical axis through
  // the box centre, where a drag on the background turns. The box is
  // symmetric under that turn, and it takes this corner to where the
  // opposite one was.
  const start = { x: canvas.x + 30, y: canvas.y + canvas.height / 2 };
  const end = { x: start.x + 1.5 * canvas.height, y: start.y };
  if (end.x <= canvas.x + canvas.width || end.x >= pageWidth)
    throw new Error(
      `a ${end.x - start.x} px drag from x = ${start.x} must end right of the canvas and on the page`,
    );
  const opposite = await screenOf(page, [10, 0, 0]);

  await dragViewport(page, start, end, 30);

  expectSamePixel(await screenOf(page, [0, 0, 4]), opposite);
});

test("releasing the button outside the viewport ends the drag", async ({
  page,
}) => {
  await openBox(page);
  const canvas = await canvasBox(page);
  // Background near the right edge, halfway down; released over the
  // sidebar, left of the canvas.
  const start = {
    x: canvas.x + canvas.width - 30,
    y: canvas.y + canvas.height / 2,
  };
  const before = await screenOf(page, FAR_CORNER);
  await dragViewport(page, start, { x: canvas.x - 100, y: start.y + 40 });
  const corner = await screenOf(page, FAR_CORNER);
  expect(Math.hypot(corner.x - before.x, corner.y - before.y)).toBeGreaterThan(
    20,
  );

  // The cursor comes back over the canvas with no button pressed.
  await hoverViewport(
    page,
    { x: canvas.x + 30, y: start.y },
    { x: canvas.x + canvas.width - 30, y: start.y - 80 },
  );

  expectSamePixel(await screenOf(page, FAR_CORNER), corner);
});

test.describe("touch", () => {
  test.use({ hasTouch: true });

  // A second finger hands the gesture to the orbit controls. The first finger
  // may then lift anywhere: outside the canvas too, and a one-finger drag
  // afterwards still turns the view.
  test("a one-finger drag turns the view after a two-finger gesture that ends outside the viewport", async ({
    page,
  }) => {
    await openBox(page);
    const canvas = await canvasBox(page);
    const midY = canvas.y + canvas.height / 2;
    const first = { id: 1, x: canvas.x + 30, y: midY };
    const second = { id: 2, x: canvas.x + canvas.width - 30, y: midY };
    const firstOutside = { ...first, x: canvas.x - 100 };
    await touchViewport(page, [
      { type: "start", fingers: [first] },
      { type: "start", fingers: [first, second] },
      { type: "move", fingers: [firstOutside, second] },
      { type: "end", fingers: [second] },
      { type: "end", fingers: [] },
    ]);
    const before = await screenOf(page, FAR_CORNER);

    const finger = { id: 3, x: canvas.x + 30, y: midY + 40 };
    await touchViewport(page, [
      { type: "start", fingers: [finger] },
      ...[1, 2, 3, 4, 5].map((i) => ({
        type: "move" as const,
        fingers: [{ ...finger, x: finger.x + 30 * i }],
      })),
      { type: "end", fingers: [] },
    ]);

    const after = await screenOf(page, FAR_CORNER);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(
      20,
    );
  });
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

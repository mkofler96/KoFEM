// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Perspective or orthographic projection (KOF-429): one button beside Fit View
// switches the viewport camera. The switch keeps the view direction, the
// target and the model's size on screen; picking, Fit View and the standard
// views work in orthographic projection, and the choice outlasts a reload.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { prismStep } from "../../examples/gallery/step-prism.mjs";
import { importStepText } from "./fixtures/split";
import { openTree } from "./fixtures/tree";
import {
  clickModelAt,
  dragViewport,
  lookFrom,
  projectPoints,
  viewCamera,
  wheelViewportAt,
  type Point,
} from "./fixtures/viewport";

// A 300 × 50 × 10 mm block.
const BLOCK = prismStep(
  [
    [0, 0],
    [300, 0],
    [300, 50],
    [0, 50],
  ],
  10,
  "block",
);

const CORNERS: Point[] = [0, 300].flatMap((x) =>
  [0, 50].flatMap((y) => [0, 10].map((z): Point => [x, y, z])),
);

function projectionButton(page: Page, name: "Perspective" | "Orthographic") {
  return page.getByRole("button", { name, exact: true });
}

// The block's corners on screen, and the canvas they must lie in.
async function cornersOnScreen(page: Page) {
  const screen = await projectPoints(page, CORNERS);
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("the viewport canvas is not on the page");
  const points = screen.map((p, i) => {
    if (!p) throw new Error(`corner ${CORNERS[i]} is behind the camera`);
    return p;
  });
  return { points, box };
}

function expectNear(a: number[], b: number[], tolerance: number) {
  a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThan(tolerance));
}

// Every corner inside the canvas, and the block spans a good part of it.
async function expectFramed(page: Page) {
  const { points, box } = await cornersOnScreen(page);
  for (const p of points) {
    expect(p.x).toBeGreaterThanOrEqual(box.x);
    expect(p.x).toBeLessThanOrEqual(box.x + box.width);
    expect(p.y).toBeGreaterThanOrEqual(box.y);
    expect(p.y).toBeLessThanOrEqual(box.y + box.height);
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const span = Math.max(
    (Math.max(...xs) - Math.min(...xs)) / box.width,
    (Math.max(...ys) - Math.min(...ys)) / box.height,
  );
  expect(span).toBeGreaterThan(0.5);
}

test("the projection button switches the camera and keeps the view @pipeline", async ({
  page,
}) => {
  await importStepText(page, BLOCK);
  const before = await viewCamera(page);
  expect(before.type).toBe("PerspectiveCamera");
  const { points: perspective } = await cornersOnScreen(page);

  await projectionButton(page, "Perspective").click();
  await expect(projectionButton(page, "Orthographic")).toBeVisible();

  const ortho = await viewCamera(page);
  expect(ortho.type).toBe("OrthographicCamera");
  expectNear(ortho.direction, before.direction, 1e-6);
  expectNear(ortho.target, before.target, 1e-6);
  // Without perspective the near end of the block shrinks and the far end
  // grows; their middle, the target, stays put and the size stays close.
  const { points: parallel } = await cornersOnScreen(page);
  const width = (ps: { x: number }[]) =>
    Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x));
  expect(width(parallel) / width(perspective)).toBeGreaterThan(0.8);
  expect(width(parallel) / width(perspective)).toBeLessThan(1.25);

  await projectionButton(page, "Orthographic").click();
  await expect(projectionButton(page, "Perspective")).toBeVisible();
  const back = await viewCamera(page);
  expect(back.type).toBe("PerspectiveCamera");
  expectNear(back.direction, before.direction, 1e-6);
  expectNear(back.target, before.target, 1e-6);
  const { points: again } = await cornersOnScreen(page);
  again.forEach((p, i) => {
    expect(Math.abs(p.x - perspective[i].x)).toBeLessThan(0.5);
    expect(Math.abs(p.y - perspective[i].y)).toBeLessThan(0.5);
  });
});

test("faces are picked in orthographic projection @pipeline", async ({
  page,
}) => {
  await importStepText(page, BLOCK);
  await openTree(page, "split");
  await page.getByTestId("split-open").click();
  await projectionButton(page, "Perspective").click();
  expect((await viewCamera(page)).type).toBe("OrthographicCamera");

  const picked = page.locator('[data-testid^="split-face-"]');
  // The top face (y = 50), then the end face (x = 300) beside it.
  await clickModelAt(page, [150, 50, 5]);
  await expect(picked).toHaveCount(1);
  const top = await picked.first().getAttribute("data-testid");
  await clickModelAt(page, [300, 25, 5]);
  await expect(picked).toHaveCount(2);
  // A second click on the top face drops it again.
  await clickModelAt(page, [150, 50, 5]);
  await expect(picked).toHaveCount(1);
  await expect(page.getByTestId(top ?? "")).toHaveCount(0);
});

test("Fit View and the standard views frame the model in orthographic projection @pipeline", async ({
  page,
}) => {
  await importStepText(page, BLOCK);
  await projectionButton(page, "Perspective").click();
  await lookFrom(page, [0, 0, 1]);
  await page.getByRole("button", { name: "Fit View" }).click();
  expect((await viewCamera(page)).type).toBe("OrthographicCamera");
  await expectFramed(page);

  // The front view (from +z) after the fit: the block's long side faces the
  // screen and stays framed.
  await lookFrom(page, [0, 0, 1]);
  const front = await viewCamera(page);
  expectNear(front.direction, [0, 0, -1], 1e-6);
  await expectFramed(page);
});

test("orbit and zoom work in orthographic projection @pipeline", async ({
  page,
}) => {
  await importStepText(page, BLOCK);
  await projectionButton(page, "Perspective").click();
  const before = await viewCamera(page);
  const { points, box } = await cornersOnScreen(page);
  const width = (ps: { x: number }[]) =>
    Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x));

  // Zoom in at the middle of the canvas: the block grows on screen.
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // Each notch zooms about 5 %.
  for (let notch = 0; notch < 4; notch++)
    await wheelViewportAt(page, middle, -100);
  const { points: zoomed } = await cornersOnScreen(page);
  expect(width(zoomed)).toBeGreaterThan(width(points) * 1.1);

  // A drag turns the view.
  await dragViewport(page, middle, { x: middle.x + 120, y: middle.y });
  const turned = await viewCamera(page);
  expect(turned.type).toBe("OrthographicCamera");
  const dot = turned.direction.reduce(
    (sum, v, i) => sum + v * before.direction[i],
    0,
  );
  expect(dot).toBeLessThan(0.99);
});

// The axial bar: 1000 × 100 × 100 mm along x, fixed at x = 0 and pulled at
// x = 1000; at mid-span Ux is half the tip extension P·L / (E·A).
test("results show and are probed in orthographic projection @pipeline", async ({
  page,
}) => {
  await page.goto("/app/?example=axial-bar");
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("colorbar")).toBeVisible();
  await page.getByTestId("plot-field").selectOption("Ux");
  await page.getByLabel("Deformation scale").fill("0");

  await projectionButton(page, "Perspective").click();
  expect((await viewCamera(page)).type).toBe("OrthographicCamera");
  await lookFrom(page, [0, 1, 0]);
  await page.getByTestId("probe-toggle").click();
  await clickModelAt(page, [500, 100, 50]);

  const value = page.getByTestId("probe-value-1");
  await expect(value).toHaveAttribute("data-value", /\d/);
  const delta = (1.0e6 * 1000) / (210000 * 100 * 100);
  expect(Number(await value.getAttribute("data-value"))).toBeCloseTo(
    delta / 2,
    2,
  );
});

test("the projection is remembered after a reload @pipeline", async ({
  page,
}) => {
  await importStepText(page, BLOCK);
  await projectionButton(page, "Perspective").click();
  await expect(projectionButton(page, "Orthographic")).toBeVisible();

  await page.reload();
  await expect(projectionButton(page, "Orthographic")).toBeVisible();
  expect((await viewCamera(page)).type).toBe("OrthographicCamera");
});

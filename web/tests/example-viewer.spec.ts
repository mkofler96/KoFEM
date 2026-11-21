// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Locator, Page } from "@playwright/test";
import { readdirSync } from "node:fs";
import { test, expect } from "./coverage";

// The interactive 3D view on every example page (public/theory/viewer.js,
// examples/validation/lib/viewer.mjs): the solved model the page's figure
// shows, to turn and zoom, with a field to switch between. The PNG figure is
// its poster and the fallback without JavaScript or WebGL.

const IDS = readdirSync("examples", { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const figureOf = (page: Page) => page.locator("figure.result");

/** Wait until the view has replaced the figure, and return its canvas. */
async function readyView(page: Page): Promise<Locator> {
  const figure = figureOf(page);
  await expect(figure).toHaveAttribute("data-ready", "");
  const canvas = figure.locator("canvas");
  await expect(canvas).toBeVisible();
  await expect(figure.locator(".viewer-stage > img")).toBeHidden();
  return canvas;
}

async function dragAcross(page: Page, canvas: Locator) {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("the view's canvas has no box");
  const midY = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, midY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, midY, { steps: 6 });
  await page.mouse.up();
}

test("every example page shows its solved model in 3D, linked to the app", async ({
  page,
}) => {
  for (const id of IDS) {
    await page.goto(`/examples/${id}/`);
    const figure = figureOf(page);
    await expect(figure, id).toHaveAttribute(
      "data-viewer",
      `/examples/${id}.result.json`,
    );
    const canvas = await readyView(page);
    // The view takes the figure's place at the figure's own proportions.
    const box = await canvas.boundingBox();
    const image = figure.locator(".viewer-stage > img");
    const width = Number(await image.getAttribute("width"));
    const height = Number(await image.getAttribute("height"));
    expect(box?.height ?? 0, id).toBeCloseTo(
      ((box?.width ?? 0) * height) / width,
      0,
    );
    await expect(page.getByTestId("open-in-app")).toHaveAttribute(
      "href",
      `/app/?example=${id}`,
    );
  }
});

test("the view turns and switches between the solved fields", async ({
  page,
}) => {
  await page.goto("/examples/plate-with-hole/");
  const figure = figureOf(page);
  const canvas = await readyView(page);
  const colorbar = figure.locator(".colorbar");
  const caption = figure.locator("figcaption");
  await expect(caption).toContainText("Von Mises stress");
  await expect(colorbar).toContainText("MPa");

  const before = await canvas.screenshot();
  await dragAcross(page, canvas);
  await expect
    .poll(async () => (await canvas.screenshot()).equals(before))
    .toBe(false);
  await figure.getByRole("button", { name: "Reset view" }).click();

  const field = figure.getByLabel("Field");
  await expect(field).toHaveValue("vonMises");
  const stress = await canvas.screenshot();
  await field.selectOption("displacement");
  // The colour bar and caption follow the field, and so do the colours.
  await expect(colorbar).toContainText("mm");
  await expect(colorbar).not.toContainText("MPa");
  await expect(caption).toContainText("Displacement magnitude");
  await expect
    .poll(async () => (await canvas.screenshot()).equals(stress))
    .toBe(false);
});

test("an optimized design shows its density and has nothing to switch", async ({
  page,
}) => {
  await page.goto("/examples/mbb-beam-topopt/");
  const figure = figureOf(page);
  await readyView(page);
  await expect(figure.getByLabel("Field")).toHaveCount(0);
  await expect(figure.locator("figcaption")).toContainText("Element density");
});

test("the page text and figure show before the view loads", async ({
  page,
}) => {
  // Hold three.js back until the test releases it.
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/vendor/three/**", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/examples/cantilever-beam/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const image = figureOf(page).locator(".viewer-stage > img");
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await expect(figureOf(page).locator("canvas")).toHaveCount(0);
  release();
  await readyView(page);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the page shows the figure, its colour bar and the link to the app", async ({
    page,
  }) => {
    await page.goto("/examples/cantilever-beam/");
    const figure = figureOf(page);
    await expect(figure.locator("img")).toBeVisible();
    await expect(figure.locator("canvas")).toHaveCount(0);
    await expect(figure.locator(".colorbar")).toContainText("mm");
    await expect(page.getByTestId("open-in-app")).toBeVisible();
  });
});

test.describe("without WebGL", () => {
  test("the figure stays", async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        ...rest: unknown[]
      ) {
        if (type.startsWith("webgl")) return null;
        return (original as (...args: unknown[]) => unknown).call(
          this,
          type,
          ...rest,
        );
      } as typeof original;
    });
    await page.goto("/examples/cantilever-beam/");
    const figure = figureOf(page);
    await expect(figure).toHaveAttribute("data-ready", "no-webgl");
    await expect(figure.locator(".viewer-stage > img")).toBeVisible();
    await expect(figure.locator("canvas")).toHaveCount(0);
  });
});

test.describe("at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("a finger turns the view and two fingers zoom it", async ({ page }) => {
    await page.goto("/examples/cantilever-beam/");
    const canvas = await readyView(page);
    // The view fits the screen: the page does not scroll sideways.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(figureOf(page).locator(".viewer-hint")).toContainText("pinch");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("the view's canvas has no box");
    const midX = box.x + box.width / 2;
    const midY = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const touch = (
      type: "touchStart" | "touchMove" | "touchEnd",
      touchPoints: { id: number; x: number; y: number }[],
    ) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });

    const before = await canvas.screenshot();
    await touch("touchStart", [{ id: 1, x: midX - 60, y: midY }]);
    for (const step of [1, 2, 3, 4, 5])
      await touch("touchMove", [{ id: 1, x: midX - 60 + 24 * step, y: midY }]);
    await touch("touchEnd", []);
    await expect
      .poll(async () => (await canvas.screenshot()).equals(before))
      .toBe(false);

    const turned = await canvas.screenshot();
    await touch("touchStart", [{ id: 2, x: midX - 20, y: midY }]);
    await touch("touchStart", [
      { id: 2, x: midX - 20, y: midY },
      { id: 3, x: midX + 20, y: midY },
    ]);
    for (const step of [1, 2, 3, 4, 5])
      await touch("touchMove", [
        { id: 2, x: midX - 20 - 12 * step, y: midY },
        { id: 3, x: midX + 20 + 12 * step, y: midY },
      ]);
    await touch("touchEnd", []);
    await cdp.detach();
    await expect
      .poll(async () => (await canvas.screenshot()).equals(turned))
      .toBe(false);
  });
});

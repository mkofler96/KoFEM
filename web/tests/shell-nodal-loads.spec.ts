// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-357: "Nodal loads" drew nothing on a shell. The plate-with-hole-shell
// example pulls the plate's end edge, the rim its end face collapsed to, which
// spans no whole facet, so the per-node glyphs found no area to share the load
// over. The nodal view must show an arrow at the loaded edge's nodes.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { settleViewport } from "./fixtures/viewport";

// Canvas pixels in the load glyphs' amber (LoadArrows LOAD_COLOR #d97706,
// shaded by the scene lights). preserveDrawingBuffer is on (Viewport.tsx), so
// the frame is still readable.
const amberPixels = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) throw new Error("viewport canvas not mounted");
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const ctx = copy.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable for canvas readback");
    ctx.drawImage(canvas, 0, 0);
    const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [red, green, blue, alpha] = [
        data[i],
        data[i + 1],
        data[i + 2],
        data[i + 3],
      ];
      if (alpha > 128 && red > 120 && red - green > 40 && green - blue > 40)
        count++;
    }
    return count;
  });

test("nodal loads show an arrow at every node of a loaded shell edge", async ({
  page,
}) => {
  await page.goto("/app/?example=plate-with-hole-shell");
  await expect(page.locator("nav")).toBeVisible();
  const toggle = page.getByRole("button", {
    name: "Toggle per-node load display",
  });
  await expect(toggle).toBeVisible();

  await settleViewport(page);
  const resultant = await amberPixels(page);
  expect(resultant, "the resultant arrow is drawn").toBeGreaterThan(0);

  await toggle.click();
  await settleViewport(page);
  const nodal = await amberPixels(page);
  // Before the fix the nodal view held no load glyph at all: only the
  // resultant's pixels disappeared.
  expect(nodal, "per-node arrows are drawn on the shell edge").toBeGreaterThan(
    0,
  );
  await page.screenshot({
    path: test.info().outputPath("shell-nodal-loads.png"),
  });
});

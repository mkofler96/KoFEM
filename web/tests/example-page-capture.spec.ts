// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import path from "path";

// Captures the figure of the plate-with-hole write-up at
// /examples/plate-with-hole/: the shipped example opened through the page's
// "Open in KoFEM" deep link, its von Mises field on the undeformed plate, seen
// square-on and zoomed to the hole. The PNG is committed next to the page and is
// also its og:image, hence exactly 1200 × 630. Regenerate it after the example's
// result changes, then re-run the page generator:
//
//   bun run examples:generate plate-with-hole
//   bun run capture:example-pages
//   bun run examples:generate-plate-hole-page
const OUT = path.resolve(
  "..",
  "examples",
  "gallery",
  "site",
  "plate-with-hole",
  "kofem-web-von-mises.png",
);
// The viewport canvas fills the window between the model tree (220 px) and the
// panel (340 px), below the header and above the status bar.
const CANVAS = { width: 1200, height: 630 };
// Mouse-wheel steps from Fit View to a frame about eight hole radii wide.
const ZOOM_STEPS = 30;

test.use({ viewport: { width: 1760, height: 702 } });

test("plate-with-hole write-up figure @capture", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/app/?example=plate-with-hole");
  await expect(page.locator("nav")).toBeVisible();
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __kofemStore?: { getState(): { nodes: unknown[] } };
        }
      ).__kofemStore?.getState().nodes.length,
    null,
    { timeout: 30_000 },
  );
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { __kofemViewport?: unknown }).__kofemViewport,
    ),
  );

  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox();
  if (
    !box ||
    box.width !== CANVAS.width ||
    Math.abs(box.height - CANVAS.height) > 0.5
  )
    throw new Error(
      `The viewport canvas is ${box?.width}×${box?.height}, not ${CANVAS.width}×${CANVAS.height} — the app layout changed; adjust the capture viewport so the figure keeps the og:image size.`,
    );

  // Von Mises on the undeformed plate, looking down −Z (X right, Y up).
  await page.evaluate(() => {
    const win = window as unknown as {
      __kofemStore: {
        getState(): {
          resultType: string;
          setDeformScale(s: number): void;
          setShowUndeformedOverlay(v: boolean): void;
        };
      };
      __kofemViewport: { lookFrom(d: [number, number, number]): void };
    };
    const st = win.__kofemStore.getState();
    if (st.resultType !== "Von Mises stress")
      throw new Error(
        `plate-with-hole opened showing "${st.resultType}", expected "Von Mises stress"`,
      );
    st.setDeformScale(0);
    st.setShowUndeformedOverlay(false);
    win.__kofemViewport.lookFrom([0, 0, 1]);
  });
  await page
    .getByRole("button", { name: "Fit View" })
    .evaluate((el) => (el.style.visibility = "hidden"));

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < ZOOM_STEPS; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(60);
  }
  await page.mouse.move(0, 0);
  await page.waitForTimeout(800);
  await expect(page.getByTestId("colorbar")).toContainText("σ_vm");

  await page.screenshot({ path: OUT, clip: box });
});

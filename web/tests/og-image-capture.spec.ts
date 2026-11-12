// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import path from "path";

// Captures the site's social preview image (Open Graph / X card) from the
// landing page's own bracket animation, at the "Inspect the result" stage, with
// the landing headline in place of the stage copy. Committed as
// web/public/og-image.png and referenced by the homepage and the generated
// Theory pages. 1200×630 is the size Facebook, LinkedIn, X and Slack expect.
// Regenerate after the landing animation or its headline changes:
//
//   bun run capture:og
const OUT = path.resolve("public", "og-image.png");

test.use({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
});

test("landing results stage → committed social image @capture", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/");
  const scene = page.locator("#scene");
  await expect(scene).toHaveAttribute("data-loaded", "true");

  // The card shows the product, not the page chrome.
  await page.addStyleTag({
    content: `
      .site-links, .progress, .model-caption, #kofem-cookie-consent { display: none !important; }
      .analysis-stage { filter: none !important; translate: none !important; }
    `,
  });

  await page.locator("#scroll-viewport").evaluate((element) => {
    const viewport = element as HTMLElement;
    viewport.style.scrollBehavior = "auto";
    viewport.scrollTop = 0.65 * (viewport.scrollHeight - viewport.clientHeight);
  });
  await expect
    .poll(async () => Number(await scene.getAttribute("data-progress")))
    .toBeCloseTo(0.65, 2);
  await expect(scene).toHaveAttribute("data-contour", "1.000");
  await expect(page.locator("#analysis-title")).toHaveText(
    "Inspect the result",
  );

  // Swap the stage copy for the landing headline, read from the page so the
  // card follows web/index.html.
  const headline = await page.locator(".intro h1").innerText();
  const tagline = await page.locator(".intro p").innerText();
  await page.evaluate(
    ({ headline, tagline }) => {
      const title = document.getElementById("analysis-title");
      const detail = document.getElementById("analysis-detail");
      if (!title || !detail)
        throw new Error("The landing results stage has no title or detail.");
      title.textContent = headline.replace(/\n/g, " ");
      detail.textContent = tagline;
      const panel = title.parentElement;
      if (!panel) throw new Error("The landing stage title has no panel.");
      panel.style.opacity = "1";
      detail.style.opacity = "1";
    },
    { headline, tagline },
  );

  await page.screenshot({ path: OUT });
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

// The Learn section at /learn/ is static HTML (no React), built the same way as
// the other marketing pages: listed in STATIC_PAGES in vite.config.ts and copied
// into dist/ verbatim. These run against `vite preview`, i.e. the build output
// that actually ships — which is the point, since the copy step is exactly what
// has silently dropped a static page before.

test("the Learn index lists both articles and links to them", async ({
  page,
}) => {
  await page.goto("/learn/");

  await expect(
    page.getByRole("heading", {
      name: "Finite elements, without the hand-waving",
    }),
  ).toBeVisible();

  await expect(
    page.getByRole("link", { name: /What a finite element solver/i }),
  ).toHaveAttribute("href", "/learn/fem-basics/");
  await expect(
    page.getByRole("link", { name: /stiffness of a hinge bracket/i }),
  ).toHaveAttribute("href", "/learn/hinge-bracket-stiffness/");
});

test("the fundamentals article renders and its shared stylesheet is applied", async ({
  page,
}) => {
  await page.goto("/learn/fem-basics/");

  await expect(
    page.getByRole("heading", {
      name: "What a finite element solver is actually doing",
      level: 1,
    }),
  ).toBeVisible();

  // /learn.css is served from public/ rather than inlined, so a broken path
  // would leave the page unstyled but still "rendering". Assert a property that
  // only the stylesheet sets.
  const bodyBg = await page
    .locator("body")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bodyBg).not.toBe("rgba(0, 0, 0, 0)");
});

test("the hinge tutorial renders its figures and offers the geometry", async ({
  page,
}) => {
  await page.goto("/learn/hinge-bracket-stiffness/");

  await expect(
    page.getByRole("heading", {
      name: "The stiffness of a hinge bracket",
      level: 1,
    }),
  ).toBeVisible();

  // Both figures are inlined SVG, not <img>: that is what lets the site's theme
  // toggle and webfont reach them. Assert they are present and actually laid
  // out — an SVG that failed to inline would leave the <figure> empty.
  for (const cls of ["svg.kf-fig", "svg.kf-chart"]) {
    const svg = page.locator(cls);
    await expect(svg).toHaveCount(1);
    await svg.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox();
    expect(box!.width).toBeGreaterThan(200);
    expect(box!.height).toBeGreaterThan(100);
  }

  // The downloadable geometry the tutorial is built around must actually be
  // served — a dead link here makes the whole walkthrough unfollowable.
  const href = await page
    .getByRole("link", { name: "scharnier.igs" })
    .getAttribute("href");
  expect(href).toBe("/examples/scharnier.igs");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
});

// The figures used to be <img src="…svg">. An <img>-loaded SVG is an isolated
// document that cannot see the page's data-theme attribute, so the site's theme
// toggle never reached them and light mode rendered near-invisible axis labels
// on a light background. Inlining fixed it; this guards the fix.
test("the tutorial figures follow the site theme", async ({ page }) => {
  const inkOf = async (theme: "dark" | "light") => {
    await page.addInitScript((t) => {
      try {
        localStorage.setItem("kofem_theme", t);
      } catch (e) {
        /* private mode — the page falls back to its default theme */
      }
    }, theme);
    await page.goto("/learn/hinge-bracket-stiffness/");
    return page
      .locator("svg.kf-chart")
      .evaluate((el) =>
        getComputedStyle(el).getPropertyValue("--fig-ink").trim(),
      );
  };

  const dark = await inkOf("dark");
  const light = await inkOf("light");
  expect(dark).not.toBe("");
  expect(light).not.toBe("");
  expect(light).not.toBe(dark);
});

test("every page in the site nav reaches the Learn section", async ({
  page,
}) => {
  for (const path of ["/", "/examples/", "/privacy/"]) {
    await page.goto(path);
    await expect(
      page.locator('.footer-bottom-inner .legal a[href="/learn/"]'),
    ).toHaveCount(1);
  }
});

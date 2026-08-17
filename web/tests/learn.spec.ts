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

  // Both figures are generated SVGs under public/learn/. A missing file still
  // renders an <img> of the declared width, so assert the images actually
  // decoded. They are loading="lazy" and below the fold, so scroll each into
  // view first or the browser never requests it.
  for (const src of ["/learn/hinge-bc.svg", "/learn/hinge-convergence.svg"]) {
    const img = page.locator(`img[src="${src}"]`);
    await img.scrollIntoViewIfNeeded();
    await expect(img).toBeVisible();
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0);
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

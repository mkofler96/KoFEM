// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

const ARTICLE = "/blog/rewriting-kofem-solver-in-rust/";
const TITLE = "Rewriting KoFEM’s finite-element solver in Rust";

test.describe("static blog", () => {
  test.use({ javaScriptEnabled: false });

  test("read the first post from the public navigation without JavaScript", async ({
    page,
  }) => {
    await page.goto("/");
    await page
      .getByRole("banner")
      .getByRole("link", { name: "Blog", exact: true })
      .click();
    await expect(page).toHaveURL(/\/blog\/$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blog");
    await expect(page.locator("main time")).toHaveText("8 November 2026");
    await page.getByRole("link", { name: TITLE, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${ARTICLE}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(TITLE);
    await expect(
      page.getByRole("link", { name: "MFEM", exact: true }),
    ).toHaveAttribute("href", "https://mfem.org/");
    await expect(
      page.getByRole("row", { name: /Tube.*6,300.*0.24 s.*0.15 s.*1.68×/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("banner").getByRole("link", { name: "Blog", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "← All posts" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Blog");
  });

  test("blog pages have canonical metadata and appear in the sitemap", async ({
    page,
  }) => {
    const sitemap = await (await page.request.get("/sitemap.xml")).text();
    for (const path of ["/blog/", ARTICLE]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        "href",
        `https://kofem.org${path}`,
      );
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        "content",
        /.+/,
      );
      expect(sitemap).toContain(`<loc>https://kofem.org${path}</loc>`);
      const schema = JSON.parse(
        (await page
          .locator('script[type="application/ld+json"]')
          .textContent())!,
      );
      expect(schema["@type"]).toBe(path === ARTICLE ? "BlogPosting" : "Blog");
      expect(schema.url).toBe(`https://kofem.org${path}`);
    }
  });

  for (const width of [320, 390]) {
    test(`blog can be read on a ${width}px screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      for (const path of ["/blog/", ARTICLE]) {
        await page.goto(path);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await expect(
          page
            .getByRole("banner")
            .getByRole("link", { name: "Blog", exact: true }),
        ).toBeInViewport();
      }
      const comparison = page.getByRole("region", {
        name: /Benchmark comparison/,
      });
      await comparison.focus();
      await comparison.press("ArrowRight");
      await expect
        .poll(() => comparison.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
    });
  }
});

test("the blog remembers the reader's theme across public pages", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/theory/");
  await page.getByRole("button", { name: "Switch to the dark theme" }).click();
  await page
    .getByRole("banner")
    .getByRole("link", { name: "Blog", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("link", { name: TITLE, exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to the light theme" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
  expect(errors).toEqual([]);
});

test("blog URLs redirect to their canonical paths and unknown posts return 404", async ({
  request,
}) => {
  for (const path of ["/blog", ARTICLE.slice(0, -1)]) {
    const response = await request.get(`${path}?from=navigation`, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(301);
    expect(response.headers().location).toBe(`${path}/?from=navigation`);
  }
  expect((await request.get("/blog/missing-post/")).status()).toBe(404);
});

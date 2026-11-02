// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

const ARTICLE = "/theory/foundations/model-and-units/";
const UNIT_PAGE = "/theory/foundations/consistent-units/";
const PAGES = ["/theory/", ARTICLE, UNIT_PAGE];

test.describe("static theory content", () => {
  test.use({ javaScriptEnabled: false });

  test("direct URLs are indexable and every local article link resolves", async ({
    page,
  }) => {
    for (const path of PAGES) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(await response?.text()).toContain("<h1>");
      await expect(page).toHaveTitle(/KoFEM Theory Guide/);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        "href",
        `https://kofem.org${path}`,
      );
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        "index, follow",
      );
      expect(
        (await page.locator('meta[name="description"]').getAttribute("content"))
          ?.length,
      ).toBeGreaterThan(50);
      expect(
        JSON.parse(
          (await page
            .locator('script[type="application/ld+json"]')
            .textContent()) ?? "",
        ),
      ).toMatchObject({
        "@context": "https://schema.org",
      });
      const links = await page
        .locator("main a[href]")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("href") ?? ""),
        );
      for (const href of new Set(links)) {
        if (!href.startsWith("/") && !href.startsWith("#")) continue;
        const url = new URL(href, `http://localhost:4173${path}`);
        const target = await page.request.get(url.pathname + url.search);
        expect(target.status(), href).toBe(200);
        if (url.hash)
          expect(await target.text(), href).toContain(
            `id="${url.hash.slice(1)}"`,
          );
      }
      const sitemap = await (await page.request.get("/sitemap.xml")).text();
      expect(sitemap).toContain(`<loc>https://kofem.org${path}</loc>`);
    }
    await page.goto(ARTICLE);
    await expect(
      page.getByRole("img", { name: "Idealised bar under axial tension" }),
    ).toBeVisible();
    await expect(page.locator("figure figcaption")).not.toBeEmpty();
    await expect(page.locator("main")).not.toContainText(
      "KoFEM implementation",
    );
  });

  test("skip link, topics and section links work by keyboard without scripts", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(ARTICLE);
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Skip to content" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      page.getByText("Theory contents", { exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    const mobileNav = page.getByRole("navigation", {
      name: "Theory topics (mobile)",
      exact: true,
    });
    await expect(
      mobileNav.getByRole("link", { name: "Model and units", exact: true }),
    ).toBeVisible();
    await expect(mobileNav.locator('[aria-current="page"]')).toHaveAttribute(
      "href",
      ARTICLE,
    );
    await page.getByText("Theory contents", { exact: true }).press("Enter");
    await page.getByText("On this page", { exact: true }).first().click();
    await page
      .locator(".article-contents")
      .getByRole("link", { name: "Choose consistent units" })
      .click();
    await expect(page).toHaveURL(`${ARTICLE}#units`);
    await expect(page.locator("h2#units")).toBeInViewport();
    await page.locator('.pager a[rel="next"]').click();
    await expect(page).toHaveURL(UNIT_PAGE);
    await page.getByRole("link", { name: /Next · planned/ }).click();
    await expect(page).toHaveURL("/theory/#foundations-reading-a-study");
    await expect(page.locator("#foundations-reading-a-study")).toContainText(
      "Planned",
    );
  });
});

for (const width of [320, 390, 1440]) {
  test(`math and navigation fit a ${width}px screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(ARTICLE);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator("main math mfrac").first()).toBeVisible();
    expect(
      await page
        .locator(".equation math")
        .first()
        .evaluate((element) => getComputedStyle(element).fontFamily),
    ).toContain("KoFEM Math");
    expect(
      await page
        .locator(".equation math")
        .first()
        .evaluate((element) => {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          selection?.removeAllRanges();
          selection?.addRange(range);
          return selection?.toString().normalize("NFKC");
        }),
    ).toContain("δ");
    const equation = page.getByRole("region", {
      name: /Axial bar dimensional check/,
    });
    if (width < 500) {
      expect(
        await equation.evaluate(
          (element) => element.scrollWidth > element.clientWidth,
        ),
      ).toBe(true);
      await equation.focus();
      await equation.press("ArrowRight");
      await expect
        .poll(() => equation.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
    }
    await expect(
      page.getByRole("banner").getByRole("link", { name: /Start Solver/ }),
    ).toBeInViewport();
    await page.goto(UNIT_PAGE);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (width < 500) {
      const table = page.getByRole("region", {
        name: /Common consistent unit systems/,
      });
      await table.focus();
      await table.press("ArrowRight");
      await expect
        .poll(() => table.evaluate((element) => element.scrollLeft))
        .toBeGreaterThan(0);
    }
  });
}

test("the unit comparison is separate and explains SI stress defaults", async ({
  page,
}) => {
  await page.goto(UNIT_PAGE);
  await expect(
    page.getByRole("heading", { level: 1, name: "Consistent unit systems" }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: "SI kg m s N Pa J", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText(
    "The default stress unit changes with the unit system.",
  );
  await expect(page.locator("main")).toContainText("Pa (N/m²)");
  await expect(page.locator("main")).toContainText("MPa (N/mm²)");
  await expect(page.locator('.pager a[rel="prev"]')).toHaveAttribute(
    "href",
    ARTICLE,
  );
  await page.goto(ARTICLE);
  await expect(
    page.getByRole("link", {
      name: "consistent unit systems reference",
      exact: true,
    }),
  ).toHaveAttribute("href", UNIT_PAGE);
  await expect(page.locator("main table")).toHaveCount(0);
});

test("Theory keeps the examples' theme choice and canonical redirects", async ({
  page,
}) => {
  await page.goto(ARTICLE);
  await page.getByRole("button", { name: "Switch to the dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.goto("/examples/axial-bar/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  for (const path of PAGES) {
    const response = await page.request.get(path.slice(0, -1), {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(301);
    expect(response.headers()["location"]).toBe(path);
  }
});

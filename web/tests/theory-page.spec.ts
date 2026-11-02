// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

const ARTICLE = "/theory/foundations/model-and-units/";
const UNIT_PAGE = "/theory/foundations/consistent-units/";
const NOTATION_PAGE = "/theory/notation/";
const OPERATOR_PAGES = [
  "/theory/operators/gradient-divergence/",
  "/theory/operators/tensor-products/",
  "/theory/operators/integration-by-parts/",
  "/theory/operators/reference-mapping/",
];
const NUMERICAL_PAGES = [
  "/theory/numerical-methods/elements-and-quadrature/",
  "/theory/numerical-methods/assembly/",
];
const PAGES = [
  "/theory/",
  ARTICLE,
  UNIT_PAGE,
  NOTATION_PAGE,
  ...OPERATOR_PAGES,
  ...NUMERICAL_PAGES,
];

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
    await page.goto(NOTATION_PAGE);
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator("main math").first()).toBeVisible();
    for (const path of [...OPERATOR_PAGES, ...NUMERICAL_PAGES]) {
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        path,
      ).toBe(true);
      await expect(page.locator("main math").first()).toBeVisible();
    }
  });
}

test("shared symbols and operators have unique, usable deep links", async ({
  page,
}) => {
  await page.goto(NOTATION_PAGE);
  const anchors = [
    "position",
    "domain",
    "boundary",
    "normal",
    "displacement",
    "test-function",
    "strain",
    "stress",
    "von-mises",
    "young-modulus",
    "poisson-ratio",
    "lame-parameters",
    "density",
    "point-force",
    "traction",
    "body-force",
    "pressure",
    "shape-functions",
    "discrete-displacement",
    "strain-displacement",
    "stiffness",
    "load-vector",
    "gradient",
    "symmetric-gradient",
    "divergence",
    "transpose",
    "dot-product",
    "outer-product",
    "double-contraction",
    "trace",
    "integral",
    "reference-coordinates",
    "jacobian",
  ];
  for (const anchor of anchors) {
    await expect(page.locator(`#${anchor}`), anchor).toHaveCount(1);
    await expect(page.locator(`#${anchor}`), anchor).not.toBeEmpty();
  }
  expect(
    await page.locator("#displacement mi").evaluate((element) => {
      return getComputedStyle(element).fontWeight;
    }),
  ).toBe("700");
  await page.goto(`${NOTATION_PAGE}#engineering-shear`);
  await expect(page.locator("#engineering-shear")).toBeInViewport();
  await expect(page.locator("main")).toContainText("engineering shear");
  await expect(page.locator("main")).toContainText("automatic unit conversion");
  await expect(
    page.locator(
      'main a[href="/theory/operators/gradient-divergence/#scalar-gradient"]',
    ),
  ).toHaveCount(1);
  await expect(page.locator("h2 a, h3 a")).toHaveCount(0);
});

test("operator articles connect notation, worked equations and reading order", async ({
  page,
}) => {
  const headings = [
    "Gradient and divergence",
    "Tensor products and contractions",
    "Integration and the weak form",
    "Reference elements and Jacobians",
  ];
  for (const [index, path] of OPERATOR_PAGES.entries()) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      headings[index],
    );
    await expect(page.locator("main .equation math").first()).toBeVisible();
    await expect(
      page.locator('main a[href^="/theory/notation/#"]').first(),
    ).toBeVisible();
    await expect(page.locator("h2 a, h3 a")).toHaveCount(0);
    expect(
      await page
        .locator(
          'main .equation:not([aria-label]), main .equation:not([tabindex="0"])',
        )
        .count(),
    ).toBe(0);
    if (index < OPERATOR_PAGES.length - 1) {
      await expect(page.locator('.pager a[rel="next"]')).toHaveAttribute(
        "href",
        OPERATOR_PAGES[index + 1],
      );
    }
  }
  const inverse = page.getByRole("region", {
    name: /^Inverse transpose Jacobian/,
  });
  await expect(inverse.locator("mtr")).toHaveCount(3);
  await expect(inverse.locator("mtr").nth(1).locator("mtd").first()).toHaveText(
    "−1/6",
  );
});

test("numerical-methods articles give checkable elements, assembly and planned links", async ({
  page,
}) => {
  const [elements, assembly] = NUMERICAL_PAGES;
  await page.goto(elements);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Elements and quadrature",
  );
  await expect(
    page.getByRole("row", {
      name: "Tetrahedron, order 2 10 30 30 × 30 4 points",
      exact: true,
    }),
  ).toBeVisible();
  const k22 = page.getByRole("region", {
    name: /^Worked tetrahedron: node 2 diagonal block/,
  });
  await expect(k22.locator("mtr")).toHaveCount(3);
  await expect(k22.locator("mtr").nth(1).locator("mtd").nth(1)).toHaveText(
    "500/3",
  );
  // Unwritten topics resolve to their planned overview entry, never a 404.
  await expect(
    page.locator('main a[href="/theory/#solid-mechanics-linear-elasticity"]'),
  ).not.toHaveCount(0);
  await expect(
    page.locator('main a[href^="/theory/solid-mechanics/"]'),
  ).toHaveCount(0);
  await expect(page.locator("main")).toContainText("KOF-274");
  await expect(page.locator('.pager a[rel="next"]')).toHaveAttribute(
    "href",
    assembly,
  );

  await page.goto(assembly);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Assembly");
  const global = page.getByRole("region", {
    name: /^Assembled three-by-three bar stiffness/,
  });
  await expect(global.locator("mtr")).toHaveCount(3);
  await expect(global.locator("mtr").nth(1).locator("mtd").nth(1)).toHaveText(
    "1+1",
  );
  await expect(
    page.getByRole("row", {
      name: "T2 (1, 2, 3, 4) 1, 2, 3, 4 6, 7, 8, 9 11, 12, 13, 14",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('.pager a[rel="prev"]')).toHaveAttribute(
    "href",
    elements,
  );
  await page.goto(NOTATION_PAGE);
  await expect(
    page.locator(`main a[href="${assembly}#dof-ordering"]`),
  ).toHaveCount(1);
});

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

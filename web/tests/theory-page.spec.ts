// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

const ARTICLE = "/theory/foundations/what-is-fem/";
const UNIT_PAGE = "/theory/foundations/consistent-units/";
const READING_PAGE = "/theory/foundations/reading-a-study/";
const VERIFICATION_PAGES = [
  "/theory/verification/axial-bar/",
  "/theory/verification/strategy/",
];
const NOTATION_PAGE = "/theory/notation/";
const OPERATOR_PAGES = [
  "/theory/operators/gradient-divergence/",
  "/theory/operators/tensor-products/",
  "/theory/operators/integration-by-parts/",
  "/theory/operators/reference-mapping/",
];
const SOLID_PAGES = [
  "/theory/solid-mechanics/linear-elasticity/",
  "/theory/solid-mechanics/equilibrium-and-weak-form/",
];
const NUMERICAL_PAGES = [
  "/theory/numerical-methods/elements-and-quadrature/",
  "/theory/numerical-methods/assembly/",
  "/theory/numerical-methods/loads-and-constraints/",
  "/theory/numerical-methods/linear-solve/",
];
const RESULT_PAGES = [
  "/theory/results/displacement-and-stress/",
  "/theory/results/interpretation-and-convergence/",
];
const SHELL_PAGES = [
  "/theory/shells/formulation/",
  "/theory/shells/solid-coupling/",
];
const OPTIMIZATION_PAGES = [
  "/theory/optimization/simp/",
  "/theory/optimization/constraints-and-convergence/",
  "/theory/optimization/interpreting-designs/",
];
const PAGES = [
  "/theory/",
  ARTICLE,
  UNIT_PAGE,
  READING_PAGE,
  NOTATION_PAGE,
  ...OPERATOR_PAGES,
  ...SOLID_PAGES,
  ...NUMERICAL_PAGES,
  ...RESULT_PAGES,
  ...VERIFICATION_PAGES,
  ...SHELL_PAGES,
  ...OPTIMIZATION_PAGES,
];

test.describe("static theory content", () => {
  test.use({ javaScriptEnabled: false });

  test("direct URLs are indexable and every local article link resolves @pipeline", async ({
    page,
  }) => {
    for (const [index, path] of PAGES.entries()) {
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
      if (index < PAGES.length - 1) {
        await expect(page.locator('.pager a[rel="next"]')).toHaveAttribute(
          "href",
          PAGES[index + 1],
        );
      } else {
        await expect(page.locator('.pager a[rel="next"]')).toHaveCount(0);
      }
      if (index > 0) {
        await expect(page.locator('.pager a[rel="prev"]')).toHaveAttribute(
          "href",
          PAGES[index - 1],
        );
      }
      const ids = await page
        .locator("[id]")
        .evaluateAll((elements) => elements.map((element) => element.id));
      expect(new Set(ids).size, path).toBe(ids.length);
      await expect(page.locator("h2 a, h3 a")).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText(/prerequisites/i);
      await expect(
        page.locator(
          'main .equation:not([aria-label]), main .equation:not([tabindex="0"])',
        ),
      ).toHaveCount(0);
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
      // The guide is read from the website: no command lines, review stamps
      // or internal issue references.
      await expect(page.locator("main pre")).toHaveCount(0);
      await expect(page.locator("main")).not.toContainText(
        /Reviewed on|KOF-\d/,
      );
      // Every figure is an SVG for the browser with a 2× PNG fallback for
      // crawlers, alt text, and the PNG listed in the sitemap.
      for (const picture of await page
        .locator("main figure.theory-figure picture")
        .all()) {
        const svg =
          (await picture
            .locator('source[type="image/svg+xml"]')
            .getAttribute("srcset")) ?? "";
        const img = picture.locator("img");
        const png = (await img.getAttribute("src")) ?? "";
        expect(svg).toMatch(/^\/theory\/figures\/[a-z0-9-]+\.svg$/);
        expect(png).toBe(svg.replace(/\.svg$/, ".png"));
        expect((await img.getAttribute("alt"))?.length).toBeGreaterThan(40);
        const vector = await page.request.get(svg);
        expect(vector.status(), svg).toBe(200);
        expect(vector.headers()["content-type"]).toContain("image/svg+xml");
        expect(await vector.text()).toContain("@font-face");
        const raster = await page.request.get(png);
        expect(raster.headers()["content-type"]).toBe("image/png");
        expect((await raster.body()).readUInt32BE(16)).toBe(
          2 * Number(await img.getAttribute("width")),
        );
        expect(sitemap).toContain(
          `<image:loc>https://kofem.org${png}</image:loc>`,
        );
      }
    }
    await page.goto(ARTICLE);
    await expect(
      page.getByRole("img", { name: /bar of length L, Young's modulus E/ }),
    ).toBeVisible();
    // Browsers show the vector SVG, not the PNG fallback.
    const first = page.locator("main figure.theory-figure img").first();
    await first.scrollIntoViewIfNeeded();
    await expect
      .poll(() => first.evaluate((e) => (e as HTMLImageElement).currentSrc))
      .toMatch(/\.svg$/);
    for (const caption of await page.locator("main figure figcaption").all())
      await expect(caption).not.toBeEmpty();
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
      mobileNav.getByRole("link", { name: "What is FEM?", exact: true }),
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
    await page.locator('.pager a[rel="next"]').click();
    await expect(page).toHaveURL(READING_PAGE);
    await page.locator('.pager a[rel="next"]').click();
    await expect(page).toHaveURL(NOTATION_PAGE);
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
        .getByRole("region", { name: /Axial extension equation/ })
        .locator("math")
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
    for (const path of [
      ...OPERATOR_PAGES,
      ...SOLID_PAGES,
      ...NUMERICAL_PAGES,
      ...RESULT_PAGES,
      READING_PAGE,
      ...VERIFICATION_PAGES,
      ...SHELL_PAGES,
      ...OPTIMIZATION_PAGES,
    ]) {
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
    "shell-quantities",
    "shell-thickness",
    "shell-rotation",
    "shell-curvature",
    "shell-force-resultant",
    "shell-moment-resultant",
    "optimization-quantities",
    "design-density",
    "simp-penalty",
    "stiffness-floor",
    "compliance",
    "element-strain-energy",
    "volume-fraction",
    "filter-radius",
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

test("solid-mechanics articles check the elastic law and the weak form", async ({
  page,
}) => {
  const [elasticity, weakForm] = SOLID_PAGES;
  await page.goto(elasticity);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Linear elasticity",
  );
  const lateral = page.getByRole("region", {
    name: /^Forward check of lateral stress/,
  });
  await expect(lateral.locator("math")).toContainText("300");
  await expect(
    page
      .getByRole("region", { name: /^Isotropic elasticity matrix D/ })
      .locator("mtr"),
  ).toHaveCount(6);
  await expect(page.locator("main")).toContainText("238095");
  await expect(page.locator('.pager a[rel="next"]')).toHaveAttribute(
    "href",
    weakForm,
  );

  await page.goto(weakForm);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Equilibrium and weak form",
  );
  await expect(
    page.getByRole("region", { name: /^Principle of virtual work/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: "Aluminium", exact: true }),
    }),
  ).toContainText("0.7143 mm");
  await expect(page.locator("#decision")).toBeVisible();
  await expect(page.locator('.pager a[rel="next"]')).toHaveAttribute(
    "href",
    NUMERICAL_PAGES[0],
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
  // Links to published topics resolve to the article, not its overview entry.
  await expect(
    page.locator('main a[href="/theory/solid-mechanics/linear-elasticity/"]'),
  ).not.toHaveCount(0);
  await expect(
    page.locator('main a[href^="/theory/#solid-mechanics"]'),
  ).toHaveCount(0);
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
  const t2 = page.getByRole("row").filter({
    has: page.getByRole("cell", { name: "6, 7, 8, 9", exact: true }),
  });
  await expect(t2.locator("th math")).toBeVisible();
  await expect(t2.locator("th")).toContainText("(1, 2, 3, 4)");
  await expect(t2.locator("td").last()).toHaveText("11, 12, 13, 14");
  // Inline math is typeset, never plain text with <sub>/<sup> tags.
  for (const path of [
    ...NUMERICAL_PAGES,
    ...OPERATOR_PAGES,
    ...SOLID_PAGES,
    NOTATION_PAGE,
  ]) {
    await page.goto(path);
    await expect(
      page.locator("main p sub, main p sup, main li sub, main li sup"),
    ).toHaveCount(0);
  }
  await page.goto(assembly);
  await expect(page.locator('.pager a[rel="prev"]')).toHaveAttribute(
    "href",
    elements,
  );
  await page.goto(NOTATION_PAGE);
  await expect(
    page.locator(`main a[href="${assembly}#dof-ordering"]`),
  ).toHaveCount(1);
});

test("loads and constraints give checkable worked examples and evidence", async ({
  page,
}) => {
  const [, assembly, loads] = NUMERICAL_PAGES;
  await page.goto(loads);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Loads and constraints",
  );
  // Nonzero prescribed displacement: the eliminated matrix keeps the diagonal.
  const eliminated = page.getByRole("region", {
    name: /^Eliminated system matrix/,
  });
  await expect(eliminated.locator("mtr")).toHaveCount(3);
  await expect(eliminated.locator("mtr").nth(1).locator("mtd")).toHaveText([
    "0",
    "2",
    "0",
  ]);
  // Force-to-traction: the nodal shares add back to the applied total.
  const total = page.getByRole("row").filter({
    has: page.getByRole("rowheader", { name: "Total", exact: true }),
  });
  await expect(total.locator("td").last()).toHaveText("1 000 000 N");
  await expect(
    page.getByRole("img", { name: /A block along x, pulled by equal/ }),
  ).toBeVisible();
  // The published shell chapter resolves to its permanent article URL.
  await expect(
    page.locator('main a[href="/theory/shells/formulation/"]'),
  ).not.toHaveCount(0);
  await expect(page.locator('.pager a[rel="prev"]')).toHaveAttribute(
    "href",
    assembly,
  );
  await page.goto(assembly);
  await expect(page.locator(`main a[href="${loads}"]`)).not.toHaveCount(0);
});

test("linear solve links the residual calculation, settings and failure evidence", async ({
  page,
}) => {
  const [, , loads, solve] = NUMERICAL_PAGES;
  await page.goto(solve);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Linear solve",
  );
  await expect(
    page.getByRole("region", { name: /^Stop when the squared/ }),
  ).toBeVisible();
  const calculation = page.getByRole("region", {
    name: /^Two-DOF bar residual/,
  });
  const firstStep = calculation.getByRole("row").filter({
    has: page.getByRole("rowheader", { name: "1", exact: true }),
  });
  await expect(firstStep.locator("td").last()).toHaveText("0.326357");
  await expect(firstStep.locator("td").nth(2)).toHaveText("99/338");
  const absolute = page.getByRole("row").filter({
    has: page.getByRole("rowheader", {
      name: "Absolute tolerance",
      exact: true,
    }),
  });
  await expect(absolute.locator("td").first()).toHaveText("0");
  await expect(page.locator('main a[href*="cg_mfem.cpp"]')).toHaveAttribute(
    "href",
    /blob\/8b542d8836f39ec4e9c7ae67c5896d39ce970078\//,
  );
  await expect(page.locator("main")).toContainText(
    "successful continuation, Stop and an exhausted iteration budget",
  );
  await expect(page.locator('.pager a[rel="prev"]')).toHaveAttribute(
    "href",
    loads,
  );
  await expect(page.locator('.pager a[rel="next"]')).toHaveAttribute(
    "href",
    RESULT_PAGES[0],
  );
  await page.goto(loads);
  await expect(page.locator('.pager a[rel="next"]')).toHaveAttribute(
    "href",
    solve,
  );
});

test("stress recovery separates solver samples from displayed averages", async ({
  page,
}) => {
  const [stress, interpretation] = RESULT_PAGES;
  await page.goto(stress);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Displacement and stress",
  );
  const tensor = page.getByRole("region", {
    name: /^Recovered stress tensor in MPa/,
  });
  await expect(tensor.locator("mtr").first().locator("mtd")).toHaveText([
    "120",
    "30",
    "0",
  ]);
  await expect(page.locator("#worked-example").locator("..")).toContainText(
    "116.19",
  );
  await expect(page.locator("main")).toContainText("137.5 MPa");
  await expect(
    page.locator('main a[href*="solve_mfem.cpp"]').first(),
  ).toHaveAttribute("href", /blob\/[a-f0-9]{40}\//);
  await expect(
    page.locator('main a[href="/examples/plate-with-hole/"]'),
  ).not.toHaveCount(0);
  await expect(page.locator('.pager a[rel="next"]')).toHaveAttribute(
    "href",
    interpretation,
  );
  await page.goto(interpretation);
  await expect(page.locator("#singularities")).toHaveText(
    "Concentration or singularity?",
  );
  await expect(page.locator("main")).toContainText("same physical location");
  await expect(page.locator('.pager a[rel="prev"]')).toHaveAttribute(
    "href",
    stress,
  );
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

test("the renamed introduction keeps its old address", async ({ page }) => {
  const response = await page.request.get(
    "/theory/foundations/model-and-units/",
    { maxRedirects: 0 },
  );
  expect(response.status()).toBe(301);
  expect(response.headers()["location"]).toBe(ARTICLE);
});

test("result viewers show the solved example in 3D with its colour bar", async ({
  page,
}) => {
  await page.goto(ARTICLE);
  const viewer = page.locator("#viewer-cantilever-beam");
  // Without script the example's own figure is shown, with the legend.
  await expect(viewer.locator(".viewer-legend")).toContainText("mm");
  await expect(
    viewer.locator('a[href="/app/?example=cantilever-beam"]'),
  ).toHaveCount(1);
  await viewer.scrollIntoViewIfNeeded();
  const canvas = viewer.locator("canvas");
  await expect(canvas).toBeVisible();
  await expect(viewer.locator(".viewer-stage > img")).toBeHidden();
  const before = await canvas.screenshot();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("viewer canvas has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  expect((await canvas.screenshot()).equals(before)).toBe(false);
  await viewer.getByRole("button", { name: "Reset view" }).click();
});

test("verified reading path reaches reproducible displacement and stress evidence", async ({
  page,
}) => {
  await page.goto("/theory/foundations/reading-a-study/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Reading a study",
  );
  await page
    .getByRole("link", { name: "axial-bar verification", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Axial-bar verification",
  );
  await expect(page.locator("#comparison").locator("..")).toContainText(
    "von Mises",
  );
  await expect(
    page.locator('main a[href="/theory/verification/strategy/"]'),
  ).not.toHaveCount(0);
  await page
    .getByRole("link", { name: "public axial-bar example", exact: true })
    .click();
  await expect(
    page.getByRole("link", {
      name: "Theory Guide’s complete axial-bar study",
      exact: true,
    }),
  ).toHaveAttribute("href", "/theory/verification/axial-bar/");
  await expect(
    page.locator('main a[href="/app/?example=axial-bar"]'),
  ).not.toHaveCount(0);
});

test("optimization chapter links theory, worked numbers, benchmarks and limits", async ({
  page,
}) => {
  await page.goto("/theory/optimization/simp/");
  const simp = page.locator("main");
  // Two-bar worked calculation rendered from the checked example module.
  await expect(simp.locator("#worked-example").locator("..")).toContainText(
    "−120",
  );
  for (const value of ["250", "0.4", "40", "10"])
    await expect(simp.locator("table").first()).toContainText(value);
  await expect(
    simp.locator('a[href="/theory/notation/#design-density"]'),
  ).not.toHaveCount(0);
  await expect(simp).toContainText("no keep-in/keep-out picker yet");

  await page.goto("/theory/optimization/constraints-and-convergence/");
  const loop = page.locator("main");
  await expect(
    page.getByRole("img", { name: /density of the MBB half-beam/ }),
  ).toBeVisible();
  await expect(
    loop.locator('a[href="/examples/mbb-beam-topopt/"]'),
  ).toHaveCount(1);
  await expect(loop.locator('a[href="/theory/optimization.json"]')).toHaveCount(
    1,
  );
  await expect(loop).toContainText("available for shell or coupled models");
  await expect(loop).toContainText("global optimum");

  await page.goto("/theory/optimization/interpreting-designs/");
  const interpret = page.locator("main");
  await expect(interpret.locator("#reanalysis")).toBeVisible();
  for (const limit of [
    "Keep-in and keep-out regions in the app.",
    "Shell and coupled stress constraints.",
  ])
    await expect(interpret).toContainText(limit);
  await expect(page.locator('.pager a[rel="next"]')).toHaveCount(0);
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import { readFile } from "node:fs/promises";

// The benchmark write-up at /examples/plate-with-hole/, written by
// examples/gallery/generate-plate-hole-page.mjs: a static, crawlable page whose
// numbers come from the gallery's own files, whose "Open in KoFEM" link opens
// the example it describes, and which the gallery links to.

const PAGE = "/examples/plate-with-hole/";
const SITE_ORIGIN = "https://kofem.org";
// The example's remote tension (examples.mjs): Kt = peak von Mises / σ.
const SIGMA = 100;

interface ManifestEntry {
  id: string;
  title: string;
  reference?: number;
  feValue?: number;
  errPct?: number;
  page?: string;
}
let plate: Required<ManifestEntry>;

test.beforeAll(async () => {
  const manifest: ManifestEntry[] = JSON.parse(
    await readFile("../examples/gallery/site/examples.json", "utf8"),
  );
  const entry = manifest.find((e) => e.id === "plate-with-hole");
  if (
    !entry ||
    entry.reference === undefined ||
    entry.feValue === undefined ||
    entry.errPct === undefined ||
    entry.page === undefined
  )
    throw new Error(
      "examples.json has no solved plate-with-hole entry with a write-up page",
    );
  plate = entry as Required<ManifestEntry>;
});

test("the write-up shows its sections, figure and the gallery's numbers", async ({
  page,
}) => {
  await page.goto(PAGE);
  await expect(page).toHaveTitle(/Plate with a Hole FEA Benchmark/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Plate with a hole in tension: Kirsch stress concentration",
  );
  expect(await page.locator("main h2").allTextContents()).toEqual([
    "Model",
    "Mesh",
    "Results",
    "Limitations",
    "Reproduce",
    "References",
  ]);

  // The same Kt and error the gallery card shows, from examples.json.
  await expect(page.getByTestId("kt-fe")).toContainText(
    plate.feValue.toFixed(3),
  );
  const sign = plate.feValue < plate.reference ? "−" : "+";
  await expect(page.getByTestId("err-kirsch")).toHaveText(
    `${sign}${plate.errPct.toFixed(1)}%`,
  );

  // The result figure is a real image of the field, with alt text.
  const figure = page.locator("figure img").first();
  await expect(figure).toHaveAttribute("alt", /von Mises stress/i);
  await expect
    .poll(() =>
      figure.evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBe(1200);
});

test("the write-up carries its search and social metadata", async ({
  page,
  request,
}) => {
  await page.goto(PAGE);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    `${SITE_ORIGIN}${PAGE}`,
  );
  const description = await page
    .locator('meta[name="description"]')
    .getAttribute("content");
  expect(description).toContain(`Kt = ${plate.feValue.toFixed(3)}`);
  expect(description!.length).toBeLessThanOrEqual(170);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    `${SITE_ORIGIN}${PAGE}kofem-web-von-mises.png`,
  );
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    "content",
    "summary_large_image",
  );

  const jsonLd = JSON.parse(
    (await page
      .locator('script[type="application/ld+json"]')
      .textContent()) as string,
  ) as { "@graph": { "@type": string; url?: string; headline?: string }[] };
  const article = jsonLd["@graph"].find((n) => n["@type"] === "TechArticle");
  expect(article?.url).toBe(`${SITE_ORIGIN}${PAGE}`);
  expect(article?.headline).toBeTruthy();

  // Listed for crawlers, and served with the consent-gated analytics loader
  // like every other static page.
  expect(await (await request.get("/sitemap.xml")).text()).toContain(
    `<loc>${SITE_ORIGIN}${PAGE}</loc>`,
  );
  expect(await (await request.get(PAGE)).text()).toContain(
    "kofem-cookie-consent",
  );
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the write-up reads in full", async ({ page }) => {
    await page.goto(PAGE);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("kt-fe")).toContainText(
      plate.feValue.toFixed(3),
    );
    await expect(
      page.getByRole("heading", { name: "Limitations" }),
    ).toBeVisible();
    await expect(page.locator("#open-in-kofem")).toHaveAttribute(
      "href",
      "/app/?example=plate-with-hole",
    );
  });
});

test("the write-up fits a phone screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(PAGE);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("the path without a trailing slash redirects to the write-up", async ({
  page,
  request,
}) => {
  const bare = PAGE.slice(0, -1);
  const res = await request.get(bare, { maxRedirects: 0 });
  expect(res.status()).toBe(301);
  expect(res.headers()["location"]).toBe(PAGE);
  await page.goto(bare);
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
  await expect(page.locator("figure img").first()).toHaveJSProperty(
    "complete",
    true,
  );
});

test("Open in KoFEM loads the example the page describes", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(PAGE);
  await page.locator("#open-in-kofem").click();
  await expect(page).toHaveURL(/\/app\/\?example=plate-with-hole$/);
  await expect(page.locator("nav")).toBeVisible();
  await page.waitForFunction(
    () => !!(window as unknown as { __kofem?: unknown }).__kofem,
  );
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __kofemStore: { getState(): { nodes: unknown[] } };
              }
            ).__kofemStore.getState().nodes.length,
        ),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  // The opened model is the solved example, and solving it again in the app
  // reproduces the field the page reports: the shipped .vtu is current.
  const opened = await page.evaluate(async () => {
    const win = window as unknown as {
      __kofem: {
        sendToWorker(name: string, payload: object): Promise<unknown>;
      };
      __kofemStore: { getState(): Record<string, unknown> };
    };
    const st = win.__kofemStore.getState();
    const saved = st.result as { vonMises: Float64Array };
    const fresh = (await win.__kofem.sendToWorker("solve", {
      nodes: st.nodes,
      elements: st.elements,
      materials: st.materials,
      properties: st.properties,
      constraints: st.constraints,
      loads: st.loads,
      surfaceLoads: st.surfaceLoads,
    })) as { vonMises: Float64Array };
    return {
      modelName: st.modelName as string,
      mode: st.mode as string,
      bcGroups: (st.bcGroups as unknown[]).length,
      loadGroups: (st.loadGroups as unknown[]).length,
      savedPeak: Math.max(...saved.vonMises),
      freshPeak: Math.max(...fresh.vonMises),
    };
  });
  expect(opened.modelName).toBe(plate.title);
  expect(opened.mode).toBe("results");
  expect(opened.bcGroups).toBe(1);
  expect(opened.loadGroups).toBe(1);
  expect(opened.savedPeak / SIGMA).toBeCloseTo(plate.feValue, 9);
  expect(
    Math.abs(opened.freshPeak - opened.savedPeak) / opened.savedPeak,
  ).toBeLessThan(1e-6);
});

test("the gallery links its plate-with-hole card to the write-up", async ({
  page,
}) => {
  await page.goto("/examples/");
  // A static link in the introduction, readable without the card script.
  await expect(
    page.locator(".page-head").getByRole("link", { name: "plate with a hole" }),
  ).toHaveAttribute("href", PAGE);

  const card = page.locator("article.card").filter({
    has: page.getByRole("heading", { name: plate.title, exact: true }),
  });
  const link = card.getByRole("link", { name: /benchmark write-up/ });
  await expect(link).toHaveAttribute("href", PAGE);
  // Only the example with a write-up links to one.
  await expect(page.locator("a.page-link")).toHaveCount(1);

  await link.click();
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

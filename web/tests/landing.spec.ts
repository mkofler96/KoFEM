// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

test("landing page renders and links to the solver app", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Finite element analysis/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Start Solver/i }),
  ).toHaveAttribute("href", "/app/");
  await expect(
    page.getByRole("link", { name: "Examples", exact: true }),
  ).toHaveAttribute("href", "/examples/");
  await page.getByText("More", { exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Privacy", exact: true }),
  ).toHaveAttribute("href", "/privacy/");
  await expect(
    page.getByRole("link", { name: "Cookie settings", exact: true }),
  ).toBeVisible();
});

test("bracket turns 90 degrees during transfer and a full turn during optimization", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const scene = page.locator("#scene");
  await expect(scene).toHaveAttribute("data-loaded", "true");
  await expect(scene).toHaveAttribute("data-topology-ready", "true");
  const canvas = scene.locator("canvas");
  const bounds = await canvas.boundingBox();
  const pose = await scene.getAttribute("data-pose-quaternion");
  const initialQuaternion = pose!.split(",").map(Number);
  const rotationFromInitial = async () => {
    const quaternion = (await scene.getAttribute("data-pose-quaternion"))!
      .split(",")
      .map(Number);
    const dot = quaternion.reduce(
      (sum, value, index) => sum + value * initialQuaternion[index],
      0,
    );
    return (2 * Math.acos(Math.min(1, Math.abs(dot))) * 180) / Math.PI;
  };
  const scrollTo = async (amount: number) => {
    await page.locator("#scroll-viewport").evaluate((element, value) => {
      const viewport = element as HTMLElement;
      const story = viewport.querySelector<HTMLElement>(".scroll-story");
      if (!story) throw new Error("The landing page has no scroll story");
      viewport.style.scrollBehavior = "auto";
      // The animation spans the story; the overview below it scrolls normally.
      viewport.scrollTop = value * (story.offsetHeight - viewport.clientHeight);
    }, amount);
    await expect
      .poll(async () => Number(await scene.getAttribute("data-progress")))
      .toBeCloseTo(amount, 2);
  };
  await scrollTo(0.2);
  await expect(scene).toHaveAttribute("data-pose-quaternion", pose!);
  await scrollTo(0.35);
  expect(await rotationFromInitial()).toBeCloseTo(45, 0);
  await scrollTo(0.5);
  expect(await rotationFromInitial()).toBeCloseTo(90, 4);
  await expect(scene).toHaveAttribute("data-rotation-axis", "vertical");
  await expect(scene).toHaveAttribute("data-rotation-degrees", "90");
  await expect(scene).toHaveAttribute("data-front-lift-degrees", "0");
  await expect(scene).toHaveAttribute(
    "data-load-direction",
    "source-positive-z",
  );
  await expect(scene).toHaveAttribute("data-torsion-nm", "0");
  await expect(page.locator("#analysis-title")).toHaveText("Local Solve");
  expect(await canvas.boundingBox()).toEqual(bounds);
  await scrollTo(0.76);
  const optimizationPose = (await scene.getAttribute("data-pose-quaternion"))!
    .split(",")
    .map(Number);
  await scrollTo(0.88);
  const halfwayPose = (await scene.getAttribute("data-pose-quaternion"))!
    .split(",")
    .map(Number);
  expect(
    Math.abs(
      halfwayPose.reduce(
        (sum, value, index) => sum + value * optimizationPose[index],
        0,
      ),
    ),
  ).toBeCloseTo(0, 2);
  await scrollTo(0.93);
  await expect(scene).toHaveAttribute("data-surface-progress", "1");
  await expect(scene).toHaveAttribute("data-optimization-playback", "1.000");
  await expect(scene).toHaveAttribute("data-iteration", "36");
  const inspectionRotation = Number(
    await scene.getAttribute("data-optimization-rotation-degrees"),
  );
  expect(inspectionRotation).toBeGreaterThan(288);
  expect(inspectionRotation).toBeLessThan(360);
  await scrollTo(1);
  await expect(scene).toHaveAttribute("data-iteration", "36");
  await expect(scene).toHaveAttribute("data-front-lift-degrees", "0");
  await expect(scene).toHaveAttribute(
    "data-optimization-rotation-degrees",
    "360",
  );
  const finalPose = (await scene.getAttribute("data-pose-quaternion"))!
    .split(",")
    .map(Number);
  expect(
    Math.abs(
      finalPose.reduce(
        (sum, value, index) => sum + value * optimizationPose[index],
        0,
      ),
    ),
  ).toBeCloseTo(1, 4);
  await expect(scene).toHaveAttribute("data-surface-busy", "false");
  await expect(scene).toHaveAttribute("data-surface-progress", "1");
  await expect(scene).toHaveAttribute(
    "data-topology-rendering",
    "smooth-isosurface",
  );
  expect(await canvas.boundingBox()).toEqual(bounds);
  await scrollTo(0);
  await expect(scene).toHaveAttribute("data-pose-quaternion", pose!);
  await expect(scene).toHaveAttribute("data-front-lift-degrees", "0");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(errors).toEqual([]);
});

const OVERVIEW = "Online FEM without installing anything";

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the served homepage says what KoFEM does and links into the site", async ({
    page,
  }) => {
    await page.goto("/");
    const overview = page.getByRole("region", { name: OVERVIEW });
    await expect(
      overview.getByRole("heading", { level: 2, name: OVERVIEW }),
    ).toBeAttached();
    await expect(overview).toContainText(
      "finite element analysis in the browser",
    );
    await expect(overview.getByRole("heading", { level: 3 })).toHaveText([
      "Import STEP and IGES",
      "Solve on your device",
      "Shells and mixed models",
      "Topology optimization",
    ]);
    const links = {
      "benchmarks with known answers": "/examples/",
      "theory guide": "/theory/",
      "open the solver": "/app/",
    };
    for (const [name, href] of Object.entries(links))
      await expect(
        overview.getByRole("link", { name, exact: true }),
      ).toHaveAttribute("href", href);
  });
});

test("scrolling past the animation lifts the bracket away and shows the overview", async ({
  page,
}) => {
  await page.goto("/");
  const scene = page.locator("#scene");
  await expect(scene).toHaveAttribute("data-loaded", "true");
  await page.locator("#scroll-viewport").evaluate((element) => {
    const viewport = element as HTMLElement;
    viewport.style.scrollBehavior = "auto";
    viewport.scrollTop = viewport.scrollHeight;
  });
  const overview = page.getByRole("region", { name: OVERVIEW });
  await expect(overview.getByRole("heading", { level: 2 })).toBeInViewport();
  await expect(scene).toHaveAttribute("data-progress", "1.000");
  // The fixed bracket stage moves up with the page instead of covering the text.
  await expect
    .poll(async () => {
      const stage = await page.locator(".stage").boundingBox();
      const section = await overview.boundingBox();
      if (!stage || !section) throw new Error("No layout box");
      return stage.y + stage.height - section.y;
    })
    .toBeLessThanOrEqual(0);
  const link = overview.getByRole("link", { name: "theory guide" });
  await expect(link).toBeInViewport();
  expect(
    await link.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return hit === element || element.contains(hit);
    }),
  ).toBe(true);
});

const SITE_ORIGIN = "https://kofem.org";
for (const path of ["/", "/examples/", "/examples/axial-bar/", "/privacy/"]) {
  test(`${path} declares its canonical URL on the production origin`, async ({
    page,
  }) => {
    await page.goto(path);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `${SITE_ORIGIN}${path}`,
    );
    expect(await page.content()).not.toContain("example.com");
  });
}

// Facebook, LinkedIn, X, Slack and Discord show no SVG previews: shared links
// need a raster og:image, and the large card needs summary_large_image.
test("social previews use the 1200×630 PNG card", async ({ page }) => {
  for (const path of [
    "/",
    "/theory/",
    "/theory/solid-mechanics/linear-elasticity/",
  ]) {
    await page.goto(path);
    const og = await page
      .locator('meta[property="og:image"]')
      .getAttribute("content");
    expect(og, path).toBe("https://kofem.org/og-image.png");
    await expect(
      page.locator('meta[name="twitter:image"]'),
      path,
    ).toHaveAttribute("content", og ?? "");
    await expect(
      page.locator('meta[name="twitter:card"]'),
      path,
    ).toHaveAttribute("content", "summary_large_image");
  }
  const card = await page.request.get("/og-image.png");
  expect(card.headers()["content-type"]).toBe("image/png");
  const png = await card.body();
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
});

test("landing page draws the mesh background behind the hero", async ({
  page,
}) => {
  await page.goto("/");
  const image = await page
    .locator("body")
    .evaluate((body) => getComputedStyle(body).backgroundImage);
  expect(image).toContain("/landing/background.webp");
  const background = await page.request.get("/landing/background.webp");
  expect(background.ok()).toBe(true);
  expect(background.headers()["content-type"]).toBe("image/webp");
});

test("on a phone the headline sits lower and the bracket higher, with room between", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const scene = page.locator("#scene");
  await expect(scene).toHaveAttribute("data-loaded", "true");
  const intro = await page.locator(".intro").boundingBox();
  if (!intro) throw new Error("The landing headline has no layout box");
  const vertical = Number(await scene.getAttribute("data-frame-vertical"));
  expect(intro.y / 844).toBeGreaterThanOrEqual(0.24);
  expect(vertical).toBeLessThanOrEqual(0.56);
  expect((intro.y + intro.height) / 844).toBeLessThan(vertical - 0.12);
});

test("the landing Start Solver button is a quiet tinted button, not a solid fill", async ({
  page,
}) => {
  await page.goto("/");
  const launch = page.getByRole("link", { name: /Start Solver/i });
  await expect(launch).toBeVisible();
  const alpha = await launch.evaluate((link) => {
    const color = getComputedStyle(link).backgroundColor;
    const parts = color.match(/[\d.]+/g);
    if (!parts) throw new Error(`Unreadable background colour: ${color}`);
    return parts.length === 4 ? Number(parts[3]) : 1;
  });
  expect(alpha).toBeLessThan(0.3);
  // The outline must not widen the button: the header has to fit 320 px.
  await expect(launch).toHaveCSS("border-top-width", "0px");
  await expect(launch).toHaveCSS("box-shadow", /inset/);
});

test("the bracket shows its CAD feature edges before the mesh draws in", async ({
  page,
}) => {
  await page.goto("/");
  const scene = page.locator("#scene");
  await expect(scene).toHaveAttribute("data-loaded", "true");
  const edges = await page.request.get("/landing/ge-engine-bracket-edges.json");
  const { segmentCount } = (await edges.json()) as { segmentCount: number };
  expect(segmentCount).toBeGreaterThan(1000);
  await expect(scene).toHaveAttribute("data-feature-edges-source", "cad");
  await expect(scene).toHaveAttribute(
    "data-feature-edges",
    String(segmentCount),
  );
  await expect(scene).toHaveAttribute("data-feature-edges-visible", "true");
});

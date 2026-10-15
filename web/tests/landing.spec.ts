// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

test("landing page renders and links to the solver app", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "KoFEM", exact: true }),
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

test("bracket stays fixed in the viewport and lifts only during optimization", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const scene = page.locator("#scene");
  await expect(scene).toHaveAttribute("data-loaded", "true");
  await expect(scene).toHaveAttribute("data-topology-ready", "true");
  const canvas = scene.locator("canvas");
  const bounds = await canvas.boundingBox();
  const pose = await scene.getAttribute("data-pose-quaternion");
  const scrollTo = async (amount: number) => {
    await page.locator("#scroll-viewport").evaluate((element, value) => {
      const viewport = element as HTMLElement;
      viewport.style.scrollBehavior = "auto";
      viewport.scrollTop =
        value * (viewport.scrollHeight - viewport.clientHeight);
    }, amount);
    await expect
      .poll(async () => Number(await scene.getAttribute("data-progress")))
      .toBeCloseTo(amount, 2);
  };
  await scrollTo(0.5);
  await expect(scene).toHaveAttribute("data-pose-quaternion", pose!);
  expect(await canvas.boundingBox()).toEqual(bounds);
  await scrollTo(1);
  await expect(scene).toHaveAttribute("data-front-lift-degrees", "18");
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

const SITE_ORIGIN = "https://kofem.org";
for (const path of ["/", "/examples/", "/privacy/"]) {
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

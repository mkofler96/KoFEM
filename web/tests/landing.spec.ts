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
      viewport.style.scrollBehavior = "auto";
      viewport.scrollTop =
        value * (viewport.scrollHeight - viewport.clientHeight);
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

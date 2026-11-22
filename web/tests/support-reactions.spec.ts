// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

// Results → Reactions (KOF-387): after a static solve the Results panel lists
// each support's reaction force and checks the reactions against the applied
// load. The cantilever example's clamp carries its 10 kN tip load — the hand
// calculation of a cantilever's support reaction.

async function solveExample(page: import("@playwright/test").Page, id: string) {
  await page.goto(`/app/?example=${id}`);
  await expect(page.locator("nav")).toBeVisible();
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("support-reactions")).toBeVisible();
}

const forceOf = async (
  locator: import("@playwright/test").Locator,
): Promise<number[]> => {
  const value = await locator.getAttribute("data-force");
  if (value === null) throw new Error("the reaction row has no data-force");
  return value.split(",").map(Number);
};

test("the cantilever's clamp reaction equals its tip load @pipeline", async ({
  page,
}) => {
  await solveExample(page, "cantilever-beam");
  const clamp = page.getByTestId("reaction-0");
  await expect(clamp).toContainText("N");
  const [fx, fy, fz] = await forceOf(clamp);
  // P = 10 kN in −y on the free end: the clamp pushes back with +10 kN.
  expect(Math.abs(fy - 1e4)).toBeLessThan(1);
  expect(Math.abs(fx)).toBeLessThan(1);
  expect(Math.abs(fz)).toBeLessThan(1);
  const balance = page.getByTestId("reaction-balance");
  await expect(balance).toHaveAttribute("data-balanced", "true");
  await expect(balance).toContainText(
    "Applied: (0, -10000, 0) N · Reactions: (0, 10000, 0) N · balanced",
  );
});

test("a shell model's reactions balance its load @pipeline", async ({
  page,
}) => {
  await solveExample(page, "plate-with-hole-shell");
  await expect(page.getByTestId("reaction-balance")).toHaveAttribute(
    "data-balanced",
    "true",
  );
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

// Results → Reactions (KOF-387): a result output added from Results → + Add,
// with its own panel. It lists each support's reaction force and checks the
// reactions against the applied load. The cantilever example's clamp carries
// its 10 kN tip load — the hand calculation of a cantilever's support reaction.

async function solveExample(page: import("@playwright/test").Page, id: string) {
  await page.goto(`/app/?example=${id}`);
  await expect(page.locator("nav")).toBeVisible();
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("colorbar")).toBeVisible();
  // Not in the plot panel until added.
  await expect(page.getByTestId("support-reactions")).toHaveCount(0);
  await page.getByTestId("tree-add-results").click();
  await page.getByTestId("add-reactions").click();
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
  const [fx, fy, fz] = await forceOf(clamp);
  // P = 10 kN in −y on the free end: the clamp pushes back with +10 kN.
  expect(Math.abs(fy - 1e4)).toBeLessThan(1);
  expect(Math.abs(fx)).toBeLessThan(1);
  expect(Math.abs(fz)).toBeLessThan(1);
  const balance = page.getByTestId("reaction-balance");
  await expect(balance).toHaveAttribute("data-balanced", "true");
  await expect(balance).toHaveText("Balanced");

  // A table: one row per support, Fx Fy Fz |F| in N, then the sum of the
  // reactions and the applied load to compare it with.
  const table = page.getByRole("table", { name: "Reaction forces" });
  await expect(table.locator("caption")).toHaveText("Forces (N)");
  await expect(table.getByRole("columnheader")).toHaveText([
    "",
    "Fx",
    "Fy",
    "Fz",
    "|F|",
  ]);
  await expect(clamp.getByRole("cell")).toHaveText([
    /\S/,
    "0",
    "10000",
    "0",
    "10000",
  ]);
  await expect(
    table.getByRole("row", { name: /^Σ reactions/ }).getByRole("cell"),
  ).toHaveText(["Σ reactions", "0", "10000", "0", "10000"]);
  await expect(
    table.getByRole("row", { name: /^Applied/ }).getByRole("cell"),
  ).toHaveText(["Applied", "0", "-10000", "0", "10000"]);
});

test("the reactions are drawn as arrows, per support or per node @pipeline", async ({
  page,
}) => {
  await solveExample(page, "cantilever-beam");
  const canvas = page.locator("canvas").first();
  const resultant = page.getByRole("button", { name: "Resultant" });
  const nodal = page.getByRole("button", { name: "Nodal" });
  // Nodal first: the arrows, the node dots and the legend share one scale.
  await expect(nodal).toHaveAttribute("aria-pressed", "true");
  await expect(resultant).toHaveAttribute("aria-pressed", "false");
  const tick = page.getByTestId("colorbar-tick-0");
  const nodalTop = await tick.textContent();

  await resultant.click();
  await expect(resultant).toHaveAttribute("aria-pressed", "true");
  const withResultant = await canvas.screenshot();
  // The legend follows the arrows: one clamp, its 10 kN resultant.
  await expect(tick).toHaveText("1.00e+4");
  expect(nodalTop).not.toBe("1.00e+4");

  await nodal.click();
  await expect
    .poll(async () => (await canvas.screenshot()).equals(withResultant))
    .toBe(false);

  // Deleting the output takes its arrows away.
  await resultant.click();
  await expect
    .poll(async () => (await canvas.screenshot()).equals(withResultant))
    .toBe(true);
  await page.getByTestId("delete-reactions").click();
  await expect
    .poll(async () => (await canvas.screenshot()).equals(withResultant))
    .toBe(false);
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

test("reactions are a result output: listed in the tree, added once, deletable @pipeline", async ({
  page,
}) => {
  await solveExample(page, "cantilever-beam");
  const row = page.getByTestId("tree-reactions-1");
  await expect(row).toHaveText("Reactions");
  await expect(page.getByTestId("panel-title")).toHaveText("Reactions");

  // The plot panel keeps no reactions of its own.
  await page.getByTestId("tree-plot-1").click();
  await expect(page.getByTestId("support-reactions")).toHaveCount(0);

  // One reactions output per model.
  await page.getByTestId("tree-add-results").click();
  await expect(page.getByTestId("add-reactions")).toBeDisabled();

  await row.click();
  await page.getByTestId("delete-reactions").click();
  await expect(row).toHaveCount(0);
  await page.getByTestId("tree-add-results").click();
  await expect(page.getByTestId("add-reactions")).toBeEnabled();
});

test("the reactions view shows the reaction force, without the displacement field @pipeline", async ({
  page,
}) => {
  await solveExample(page, "cantilever-beam");
  const legend = page.getByTestId("colorbar");
  // Its own legend: the nodal reaction force, from the smallest to the
  // largest held node, and no legend range to edit.
  await expect(legend).toContainText("|F| [N]");
  await expect(page.getByTestId("legend-edit")).toHaveCount(0);
  const top = Number(await page.getByTestId("colorbar-tick-0").textContent());
  const bottom = Number(
    await page.getByTestId("colorbar-tick-4").textContent(),
  );
  // The clamp's bending moment shows as push-pull pairs, so a single node
  // can carry more than the 10 kN shear the whole clamp sums to.
  expect(bottom).toBeGreaterThan(0);
  expect(top).toBeGreaterThan(bottom);
  // No min and max labels of the displacement.
  await expect(page.getByTestId("probe-label-max")).toHaveCount(0);
  await expect(page.getByTestId("probe-label-min")).toHaveCount(0);

  // The plot brings its field back.
  await page.getByTestId("tree-plot-1").click();
  await expect(legend).toContainText("|U| [mm]");
  await expect(page.getByTestId("probe-label-max")).toBeVisible();
  await page.getByTestId("tree-reactions-1").click();
  await expect(legend).toContainText("|F| [N]");
});

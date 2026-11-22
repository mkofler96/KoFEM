// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Result probes (KOF-389): in Results, the probe tool reads the plotted field
// where the user clicks the model; the point and the displacement vector show
// on hover. Several probes can be placed, each with a label in the viewport
// and a row in the panel, and removed. Min and max probes mark where the field
// peaks. A probe stays on its CAD face through a re-mesh and shows the new
// solve's value. Solid (the axial bar) and shell (the plate with a hole).

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { openTree } from "./fixtures/tree";
import { clickModelAt, lookFrom, type Point } from "./fixtures/viewport";

async function solveExample(page: Page, id: string): Promise<void> {
  await page.goto(`/app/?example=${id}`);
  await expect(page.locator("nav")).toBeVisible();
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("colorbar")).toBeVisible();
}

// The undeformed shape, so a model-space point is where it is drawn.
async function showUndeformed(page: Page): Promise<void> {
  await page.getByLabel("Deformation scale").fill("0");
}

async function probeValue(
  page: Page,
  id: number | "min" | "max",
): Promise<number> {
  const value = page.getByTestId(`probe-value-${id}`);
  await expect(value).toHaveAttribute("data-value", /\d/);
  return Number(await value.getAttribute("data-value"));
}

// The axial bar: 1000 × 100 × 100 mm along x, fixed at x = 0 and pulled by
// 1 MN at x = 1000. Away from the ends Ux grows linearly to the tip extension
// δ = P·L / (E·A) = 0.4762 mm.
const DELTA = (1.0e6 * 1000) / (210000 * 100 * 100);
const onTop = (x: number): Point => [x, 100, 50];

test("probes read the field where the model is clicked, and can be removed @pipeline", async ({
  page,
}) => {
  await solveExample(page, "axial-bar");
  await page.getByTestId("plot-field").selectOption("Ux");
  await showUndeformed(page);
  await lookFrom(page, [0, 1, 0]);

  await page.getByTestId("probe-toggle").click();
  await clickModelAt(page, onTop(500));
  await clickModelAt(page, onTop(250));

  // Each probe: a row with the value and unit, the displacement vector, and a
  // label on the model.
  await expect(page.getByTestId("probe-row-1")).toContainText("P1");
  await expect(page.getByTestId("probe-value-1")).toContainText("mm");
  expect(await probeValue(page, 1)).toBeCloseTo(DELTA / 2, 2);
  expect(await probeValue(page, 2)).toBeCloseTo(DELTA / 4, 2);
  await expect(page.getByTestId("probe-label-1")).toContainText("P1");
  await expect(page.getByTestId("probe-label-2")).toContainText("P2");

  // The point and the displacement vector show only on hover, in the panel
  // row and on the viewport label.
  await expect(page.getByTestId("probe-vector-1")).toBeHidden();
  await page.getByTestId("probe-row-1").hover();
  await expect(page.getByTestId("probe-vector-1")).toBeVisible();
  await expect(page.getByTestId("probe-vector-1")).toContainText("mm");
  await expect(page.getByTestId("probe-label-details-1")).toBeHidden();
  await page.getByTestId("probe-label-1").hover();
  await expect(page.getByTestId("probe-label-details-1")).toBeVisible();
  await expect(page.getByTestId("probe-label-details-1")).toContainText("(500");

  // The plotted field changes what the probes read.
  await page.getByTestId("plot-field").selectOption("Von Mises stress");
  await expect(page.getByTestId("probe-value-1")).toContainText("MPa");
  // σ = P / A = 100 MPa in the uniform part of the bar.
  expect(await probeValue(page, 1)).toBeGreaterThan(90);
  expect(await probeValue(page, 1)).toBeLessThan(110);
  await page.getByTestId("plot-field").selectOption("Ux");

  await page.getByTestId("probe-remove-1").click();
  await expect(page.getByTestId("probe-row-1")).toHaveCount(0);
  await expect(page.getByTestId("probe-label-1")).toHaveCount(0);
  await expect(page.getByTestId("probe-row-2")).toBeVisible();
});

test("min and max probes mark where the plotted field peaks @pipeline", async ({
  page,
}) => {
  await solveExample(page, "axial-bar");
  await page.getByTestId("plot-field").selectOption("Ux");

  // Ux is 0 on the fixed end and largest on the pulled end.
  await expect(page.getByTestId("probe-label-max")).toContainText("Max");
  await expect(page.getByTestId("probe-label-min")).toContainText("Min");
  const max = await probeValue(page, "max");
  expect(Math.abs(max - DELTA) / DELTA).toBeLessThan(0.02);
  expect(Math.abs(await probeValue(page, "min"))).toBeLessThan(1e-9);
  await page.getByTestId("probe-label-max").hover();
  await expect(page.getByTestId("probe-label-details-max")).toContainText(
    "(1000",
  );

  // They follow the plotted field.
  await page.getByTestId("plot-field").selectOption("Von Mises stress");
  await expect(page.getByTestId("probe-value-max")).toContainText("MPa");

  // Their labels can be hidden; the panel keeps the values.
  await page.getByTestId("probe-extremes").uncheck();
  await expect(page.getByTestId("probe-label-max")).toHaveCount(0);
  await expect(page.getByTestId("probe-row-max")).toBeVisible();
  await page.getByTestId("probe-extremes").check();
  await expect(page.getByTestId("probe-label-max")).toBeVisible();
});

test("a probe stays on its CAD face through a re-mesh and shows the new value @pipeline", async ({
  page,
}) => {
  await solveExample(page, "axial-bar");
  await page.getByTestId("plot-field").selectOption("Ux");
  await showUndeformed(page);
  await lookFrom(page, [0, 1, 0]);
  await page.getByTestId("probe-toggle").click();
  await clickModelAt(page, onTop(500));
  const before = await probeValue(page, 1);

  // Re-mesh coarser, as a user would in the Mesh panel, and solve again.
  const nodeCount = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __kofemStore: { getState(): { nodes: unknown[] } };
          }
        ).__kofemStore.getState().nodes.length,
    );
  const nodesBefore = await nodeCount();
  await openTree(page, "mesh");
  await page.getByTestId("max-element-size").fill("40");
  await page.getByTestId("min-element-size").fill("4");
  await page.getByTestId("mesh-generate").click();
  await expect.poll(nodeCount).not.toBe(nodesBefore);
  await openTree(page, "static");
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("colorbar")).toBeVisible();
  await page.getByTestId("plot-field").selectOption("Ux");

  await expect(page.getByTestId("probe-row-1")).toBeVisible();
  await expect(page.getByTestId("probe-label-1")).toContainText("P1");
  const after = await probeValue(page, 1);
  expect(after).toBeCloseTo(DELTA / 2, 2);
  // Read on the new mesh and solve, not kept from the old one.
  expect(after).not.toBe(before);
});

test("probes work on a shell @pipeline", async ({ page }) => {
  // The quarter strip with a hole as a shell: mid-surface z = 0.5 mm, pulled
  // by σ = 100 MPa at x = 150. Far from the hole the stress is σ.
  await solveExample(page, "plate-with-hole-shell");
  await page.getByTestId("plot-field").selectOption("Von Mises stress");
  await showUndeformed(page);
  await lookFrom(page, [0, 0, 1]);
  await page.getByTestId("probe-toggle").click();
  await clickModelAt(page, [120, 25, 0.5]);

  await expect(page.getByTestId("probe-label-1")).toContainText("P1");
  await expect(page.getByTestId("probe-value-1")).toContainText("MPa");
  const value = await probeValue(page, 1);
  expect(value).toBeGreaterThan(90);
  expect(value).toBeLessThan(110);
  await page.getByTestId("probe-row-1").hover();
  await expect(page.getByTestId("probe-vector-1")).toContainText("mm");
});

// Stress components (KOF-447): the axial bar carries σxx = P / A = 100 MPa and
// no shear, which a probe placed by its coordinates reads; on a shell model the
// Results panel offers the surface the components are read on.
async function probeAt(page: Page, [x, y, z]: Point): Promise<void> {
  await page.getByTestId("probe-at-x").fill(String(x));
  await page.getByTestId("probe-at-y").fill(String(y));
  await page.getByTestId("probe-at-z").fill(String(z));
  await page.getByTestId("probe-at-add").click();
}

test("a stress component is read by a probe placed at typed coordinates @pipeline", async ({
  page,
}) => {
  await solveExample(page, "axial-bar");
  await page.getByTestId("plot-field").selectOption("Normal stress σxx");
  await expect(page.getByTestId("colorbar")).toContainText("σxx [MPa]");
  // A solid model has no shell surface to choose.
  await expect(page.getByTestId("shell-surface")).toHaveCount(0);
  await probeAt(page, [500, 50, 100]);
  await expect(page.getByTestId("probe-row-1")).toContainText("P1 · σxx");
  expect(await probeValue(page, 1)).toBeCloseTo(100, 0);
  await page.getByTestId("plot-field").selectOption("Shear stress τxy");
  expect(Math.abs(await probeValue(page, 1))).toBeLessThan(1);
  await page.getByTestId("plot-field").selectOption("Max principal stress σ1");
  expect(await probeValue(page, 1)).toBeCloseTo(100, 0);

  // Coordinates that are not numbers are refused with a message.
  await page.getByTestId("probe-at-x").fill("abc");
  await page.getByTestId("probe-at-add").click();
  await expect(page.getByTestId("probe-at-error")).toContainText("numbers");
  await expect(page.getByTestId("probe-row-2")).toHaveCount(0);
});

test("a shell model reads its stress components on the chosen surface @pipeline", async ({
  page,
}) => {
  await solveExample(page, "plate-with-hole-shell");
  await page.getByTestId("plot-field").selectOption("Normal stress σxx");
  await expect(page.getByTestId("shell-surface")).toHaveValue("top");
  // Far from the hole, at the pulled end, the plate carries σ = 100 MPa in
  // membrane tension: the same on both surfaces.
  await probeAt(page, [145, 45, 0.5]);
  const top = await probeValue(page, 1);
  expect(top).toBeGreaterThan(90);
  expect(top).toBeLessThan(110);
  await page.getByTestId("shell-surface").selectOption("bottom");
  expect(await probeValue(page, 1)).toBeCloseTo(top, 3);
});

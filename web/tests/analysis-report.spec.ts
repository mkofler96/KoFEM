// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Results → Report (KOF-391): one click saves a self-contained HTML report of
// the analysis. Its numbers must be the ones the app shows: the max of the
// displacement and von Mises fields as the Min and max block reads them, the
// support reactions as Results → Reactions lists them. Each element family
// (solid, shell, the two coupled) names itself in the body table, a shell with
// its thickness.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect } from "./coverage";
import type { Browser, Page } from "@playwright/test";
import { openTree, setElementType } from "./fixtures/tree";

const here = dirname(fileURLToPath(import.meta.url));
const FIN_STEP = join(here, "../../test_files/fin_two_parts.step");

async function solveExample(page: Page, id: string): Promise<void> {
  await page.goto(`/app/?example=${id}`);
  await expect(page.locator("nav")).toBeVisible();
  await runSolve(page);
}

async function runSolve(page: Page): Promise<void> {
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("colorbar")).toBeVisible();
}

// The max of `field` as the plot panel's Min and max block shows it.
async function shownMax(page: Page, field: string): Promise<number> {
  await page.getByTestId("tree-plot-1").click();
  await page.getByTestId("plot-field").selectOption(field);
  const max = page.getByTestId("probe-value-max");
  await expect(max).toBeVisible();
  return Number(await max.getAttribute("data-value"));
}

// Σ of the support reactions as Results → Reactions lists them.
async function shownReactionSum(page: Page): Promise<number[]> {
  await page.getByTestId("tree-add-results").click();
  await page.getByTestId("add-reactions").click();
  const rows = page.locator("[data-testid^='reaction-'][data-force]");
  await expect(rows.first()).toBeVisible();
  const sum = [0, 0, 0];
  for (const force of await rows.evaluateAll((all) =>
    all.map((row) => row.getAttribute("data-force") ?? ""),
  ))
    force.split(",").forEach((value, axis) => (sum[axis] += Number(value)));
  return sum;
}

// Click Report on the shown plot and open the saved file in a page of its own
// that may load nothing from anywhere: every request it makes is recorded.
async function saveReport(
  page: Page,
  browser: Browser,
  plot = "tree-plot-1",
): Promise<{ report: Page; html: string; requests: string[] }> {
  await page.getByTestId(plot).click();
  const button = page.getByTestId("report-save");
  await expect(button).toBeEnabled();
  const download = page.waitForEvent("download");
  await button.click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.html$/);
  const path = await file.path();
  const html = await readFile(path, "utf8");
  const context = await browser.newContext();
  const report = await context.newPage();
  const requests: string[] = [];
  report.on("request", (request) => requests.push(request.url()));
  await report.setContent(html, { waitUntil: "load" });
  return { report, html, requests };
}

const valueOf = async (report: Page, testId: string): Promise<number> =>
  Number(await report.getByTestId(testId).getAttribute("data-value"));

test("the cantilever's report states the numbers Results shows @pipeline", async ({
  page,
  browser,
}) => {
  await solveExample(page, "cantilever-beam");
  const maxDisplacement = await shownMax(page, "Displacement (magnitude)");
  const maxVonMises = await shownMax(page, "Von Mises stress");
  const reactionSum = await shownReactionSum(page);

  const { report, html, requests } = await saveReport(page, browser);

  // Self-contained: nothing to fetch, no address to send anything to.
  expect(requests.filter((url) => !url.startsWith("data:"))).toEqual([]);
  expect(html).not.toMatch(/(src|href)\s*=\s*["']?(https?:)?\/\//i);

  expect(await valueOf(report, "report-max-displacement")).toBeCloseTo(
    maxDisplacement,
    9,
  );
  expect(await valueOf(report, "report-max-von-mises")).toBeCloseTo(
    maxVonMises,
    9,
  );
  // The 99th percentile sits at or below the peak, and above zero.
  const p99 = await valueOf(report, "report-p99-von-mises");
  expect(p99).toBeGreaterThan(0);
  expect(p99).toBeLessThanOrEqual(maxVonMises);

  const sumAttribute = await report
    .getByTestId("report-reaction-sum")
    .getAttribute("data-force");
  if (sumAttribute === null)
    throw new Error("the report's reaction sum has no data-force");
  const sum = sumAttribute.split(",").map(Number);
  sum.forEach((value, axis) =>
    expect(Math.abs(value - reactionSum[axis])).toBeLessThan(1e-6),
  );
  await expect(report.getByTestId("report-balance")).toHaveAttribute(
    "data-balanced",
    "true",
  );

  await expect(report.getByTestId("report-body-1")).toHaveAttribute(
    "data-element",
    "solid",
  );
  await expect(report.getByTestId("report-solver-path")).toHaveAttribute(
    "data-path",
    "solid",
  );

  // Two figures, drawn by the app's canvas, beside the app's legend.
  for (const figure of ["report-figure-current", "report-figure-iso"]) {
    const image = report.getByTestId(figure);
    await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/);
    expect(
      await image.evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBeGreaterThan(0);
  }
  await expect(report.getByTestId("report-legend")).toBeVisible();

  // It prints: Chromium's print to PDF takes it.
  const pdf = await report.pdf({ format: "A4" });
  expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
});

test("a shell model's report names its elements and their thickness @pipeline", async ({
  page,
  browser,
}) => {
  await solveExample(page, "plate-with-hole-shell");
  const maxVonMises = await shownMax(page, "Von Mises stress");
  const { report } = await saveReport(page, browser);
  // The shell property is the one the triangles use.
  const shell = await page.evaluate(() => {
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            elements: { type: string; propertyId: number }[];
            properties: { id: number; thickness?: number }[];
          };
        };
      }
    ).__kofemStore.getState();
    const id = state.elements.find((e) => e.type === "CTRIA3")?.propertyId;
    return state.properties.find((p) => p.id === id);
  });
  if (!shell) throw new Error("the example has no shell elements");
  const thickness = shell.thickness;
  expect(thickness).toBeGreaterThan(0);

  const body = report.getByTestId(`report-body-${shell.id}`);
  await expect(body).toHaveAttribute("data-element", "shell");
  await expect(body).toHaveAttribute("data-thickness", String(thickness));
  await expect(report.getByTestId("report-solver-path")).toHaveAttribute(
    "data-path",
    "shell",
  );
  expect(await valueOf(report, "report-max-von-mises")).toBeCloseTo(
    maxVonMises,
    9,
  );
});

test("a coupled shell and solid model's report lists both families @pipeline", async ({
  page,
  browser,
}) => {
  await page.goto("/app/");
  await expect(page.locator("nav")).toBeVisible();
  await page.setInputFiles('input[accept=".stp,.step"]', FIN_STEP);
  await expect(page.getByTestId("tree-body-2")).toBeVisible();
  // Body 2 is the 2 mm fin under the 50 × 100 × 30 mm base block.
  await setElementType(page, 2, "shell");
  await openTree(page, "add-mesh");
  await page.getByRole("button", { name: /Generate mesh/i }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __kofemStore: { getState(): { nodes: unknown[] } };
            }
          ).__kofemStore.getState().nodes.length,
      ),
    )
    .toBeGreaterThan(0);
  // Supports and loads on node sets: the top of the block held, the fin's
  // free edge pushed sideways. The report, not face picking, is under test.
  await page.evaluate(() => {
    type Store = {
      getState(): {
        nodes: { id: number; z: number }[];
        createBcGroup(
          faces: { label: string; nodeIds: number[]; geometry: string }[],
          dofs: number[],
          value: number,
        ): void;
        createLoadGroup(
          faces: { label: string; nodeIds: number[]; geometry: string }[],
          dof: number,
          totalForce: number,
          kind: string,
          components: [number, number, number],
        ): void;
      };
    };
    const store = (window as unknown as { __kofemStore: Store }).__kofemStore;
    const { nodes } = store.getState();
    const near = (z: number) =>
      nodes.filter((node) => Math.abs(node.z - z) < 1e-6).map((n) => n.id);
    const bottom = Math.min(...nodes.map((node) => node.z));
    store
      .getState()
      .createBcGroup(
        [{ label: "Block top", nodeIds: near(30), geometry: "face" }],
        [0, 1, 2],
        0,
      );
    store
      .getState()
      .createLoadGroup(
        [{ label: "Fin edge", nodeIds: near(bottom), geometry: "edge" }],
        1,
        100,
        "force",
        [0, 100, 0],
      );
  });
  await page.getByTestId("tree-add-studies").click();
  await page.getByTestId("add-study-static").click();
  await runSolve(page);
  const maxDisplacement = await shownMax(page, "Displacement (magnitude)");

  const { report } = await saveReport(page, browser);
  const shellBody = await page.evaluate(() =>
    (
      window as unknown as {
        __kofemStore: {
          getState(): {
            properties: { id: number; thickness?: number }[];
          };
        };
      }
    ).__kofemStore
      .getState()
      .properties.find((p) => p.thickness !== undefined),
  );
  if (!shellBody) throw new Error("the fin was not meshed as shells");

  await expect(report.getByTestId("report-body-1")).toHaveAttribute(
    "data-element",
    "solid",
  );
  const shell = report.getByTestId(`report-body-${shellBody.id}`);
  await expect(shell).toHaveAttribute("data-element", "shell");
  await expect(shell).toHaveAttribute(
    "data-thickness",
    String(shellBody.thickness),
  );
  await expect(report.getByTestId("report-solver-path")).toHaveAttribute(
    "data-path",
    "coupled",
  );
  expect(await valueOf(report, "report-max-displacement")).toBeCloseTo(
    maxDisplacement,
    9,
  );
});

// The report prints as A4 pages with a footer on each (KOF-391 style).
test("the report prints with a page footer and keeps every block whole @pipeline", async ({
  page,
  browser,
}) => {
  await solveExample(page, "cantilever-beam");
  const { report, html } = await saveReport(page, browser);
  expect(html).toMatch(/@page\s*\{[^}]*size:\s*A4/);
  expect(html).toContain("counter(pages)");
  // Every section is one block that print never splits, and no table shares
  // a row with a figure.
  const blocks = report.locator("section.blk");
  expect(await blocks.count()).toBeGreaterThan(4);
  expect(
    await report.evaluate(
      () => [...document.querySelectorAll(".figs table, figure table")].length,
    ),
  ).toBe(0);
  await expect(report.locator("math").first()).toBeAttached();
});

type StoreWindow = { __kofemStore: { getState(): Record<string, unknown> } };

test("a mesh refinement study gets its own section in the report @pipeline", async ({
  page,
  browser,
}) => {
  await solveExample(page, "cantilever-beam");
  await openTree(page, "refinement");
  await page.getByTestId("refinement-study-run").click();
  const verdict = page.getByTestId("refinement-study-verdict");
  await expect(verdict).toBeVisible();
  const appVerdict = (await verdict.textContent()) ?? "";
  const levels = await page.evaluate(
    () =>
      (
        (window as unknown as StoreWindow).__kofemStore.getState()
          .refinementStudy as {
          levels: { elements: number; maxDisplacement: number }[];
        }
      ).levels,
  );
  expect(levels.length).toBeGreaterThanOrEqual(2);

  const { report } = await saveReport(page, browser);
  const section = report.getByTestId("report-refinement");
  await expect(section).toBeVisible();
  await expect(section.locator("svg.chart")).toHaveCount(2);
  await expect(section).toContainText(appVerdict.trim());
  const rows = section.getByTestId("report-refinement-level");
  await expect(rows).toHaveCount(levels.length);
  for (const [k, level] of levels.entries()) {
    await expect(rows.nth(k)).toHaveAttribute(
      "data-elements",
      String(level.elements),
    );
    expect(
      Number(await rows.nth(k).getAttribute("data-max-displacement")),
    ).toBeCloseTo(level.maxDisplacement, 9);
  }
});

test("a topology optimization gets its own section in the report @pipeline", async ({
  page,
  browser,
}) => {
  // The example opens on its optimization; a few iterations make a history,
  // and the static solve after it gives the report its result.
  await page.goto("/app/?example=mbb-beam-topopt");
  await expect(page.locator("nav")).toBeVisible();
  await openTree(page, "topopt");
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByLabel("Max iters").fill("12");
  await page.getByRole("button", { name: /Run optimization/ }).click();
  await expect(page.getByText("Run summary")).toBeVisible();
  await openTree(page, "static");
  await runSolve(page);
  const run = await page.evaluate(() => {
    const state = (window as unknown as StoreWindow).__kofemStore.getState();
    const result = state.densityResult as {
      iterations: number;
      history: unknown[];
    };
    const plots = state.resultPlots as { id: number; source: string }[];
    const plot = plots.find((p) => p.source === "static");
    if (!plot) throw new Error("the static solve made no result plot");
    return {
      iterations: result.iterations,
      history: result.history.length,
      threshold: state.densityThreshold as number,
      staticPlot: plot.id,
    };
  });

  // Plot 1 is the density; Report sits on the static result's plot.
  const { report } = await saveReport(
    page,
    browser,
    `tree-plot-${run.staticPlot}`,
  );
  const section = report.getByTestId("report-topology");
  await expect(section).toBeVisible();
  await expect(section.locator("svg.chart")).toHaveCount(2);
  const density = report.getByTestId("report-figure-density");
  await expect(density).toHaveAttribute("src", /^data:image\/png;base64,/);
  expect(
    await density.evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBeGreaterThan(0);
  await expect(
    report.getByTestId("report-topology-iterations"),
  ).toHaveAttribute("data-value", String(run.iterations));
  await expect(report.getByTestId("report-density-cutoff")).toHaveAttribute(
    "data-value",
    String(run.threshold),
  );
  // The static figures still show the static result, not the density.
  await expect(report.getByTestId("report-figure-current")).toBeVisible();
});

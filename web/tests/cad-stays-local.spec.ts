// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Request } from "@playwright/test";
import { fileURLToPath } from "url";
import { test, expect } from "./coverage";
import { buildCantilever } from "./fixtures/cantilever";
import { gotoApp } from "./fixtures/app";

// KoFEM says where visitors decide whether to try it that their CAD stays on
// their device (KOF-392): one line in the homepage hero, linking to the
// privacy page, and a few words at the app's import step. The pipeline test
// keeps the claim true: importing, meshing and solving send nothing anywhere.

const CLAIM = "Your CAD never leaves your device.";

test("the homepage hero says CAD stays on the device and links to the privacy page", async ({
  page,
}) => {
  await page.goto("/");
  const intro = page.locator(".intro");
  const claim = intro.getByRole("link", { name: CLAIM });
  await expect(claim).toBeVisible();
  await expect(claim).toHaveAttribute("href", "/privacy/");
  // Clickable although the stage around it lets pointer events through.
  await claim.click();
  await expect(page).toHaveURL(/\/privacy\/$/);
});

test("once the hero fades, its privacy link leaves the tab order", async ({
  page,
}) => {
  await page.goto("/");
  const scene = page.locator("#scene");
  await expect(scene).toHaveAttribute("data-loaded", "true");
  const intro = page.locator(".intro");
  await expect(intro).toHaveJSProperty("inert", false);
  await page.locator("#scroll-viewport").evaluate((element) => {
    const viewport = element as HTMLElement;
    viewport.style.scrollBehavior = "auto";
    viewport.scrollTop = 0.3 * (viewport.scrollHeight - viewport.clientHeight);
  });
  await expect(intro).toHaveJSProperty("inert", true);
});

test("the app's import step says CAD stays on the device", async ({ page }) => {
  await gotoApp(page);
  await expect(page.getByRole("button", { name: "Import STEP" })).toBeVisible();
  await expect(page.getByText(CLAIM, { exact: true })).toBeVisible();
});

const STEP_FILE = fileURLToPath(
  new URL("./fixtures/tube.stp", import.meta.url),
);

test("importing, meshing and solving send nothing off the device @pipeline", async ({
  page,
  context,
  baseURL,
}) => {
  if (!baseURL) throw new Error("the Playwright config sets no baseURL");
  const origin = new URL(baseURL).origin;
  // The context sees the page's requests and its solver worker's.
  const requests: Request[] = [];
  context.on("request", (request) => requests.push(request));

  await gotoApp(page);
  await page
    .locator('input[type="file"][accept=".stp,.step"]')
    .setInputFiles(STEP_FILE);
  await page.getByRole("button").filter({ hasText: "Generate mesh" }).click();
  await expect(page.getByText("Mesh OK")).toBeVisible();

  const model = buildCantilever();
  const displacements = await page.evaluate(async (m) => {
    const kofem = (
      window as unknown as {
        __kofem: {
          sendToWorker(name: string, payload: object): Promise<unknown>;
        };
      }
    ).__kofem;
    const result = (await kofem.sendToWorker("solve", {
      solverMethod: "gauss-seidel",
      nodes: m.nodes,
      elements: m.elements,
      materials: m.materials,
      properties: m.properties,
      constraints: m.constraints,
      loads: m.loads,
    })) as { displacements: number[] };
    return result.displacements.length;
  }, model);
  expect(displacements).toBe(model.nodes.length * 3);

  // Only reads of the app's own files: no upload, and no other host.
  const offDevice = requests
    .filter(
      (request) =>
        request.method() !== "GET" ||
        request.postData() !== null ||
        (!request.url().startsWith("blob:") &&
          !request.url().startsWith("data:") &&
          new URL(request.url()).origin !== origin),
    )
    .map((request) => `${request.method()} ${request.url()}`);
  expect(offDevice).toEqual([]);
  expect(requests.length).toBeGreaterThan(0);
});

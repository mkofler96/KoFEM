// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";

// KOF-265: the top bar's Feedback entry leads to the GitHub issue forms. KoFEM
// sends nothing itself; a report carries diagnostics only when the user ticks
// them in, and never geometry, file names or results. github.com is stubbed,
// so the test only inspects the URL the app opens. The diagnostics builder is
// unit-tested in tests/test_feedback.mjs.

const TUBE = readFileSync(new URL("./fixtures/tube.stp", import.meta.url));
// The tube, imported under a name that must not reach the report.
const SECRET_FILE = "secret-bracket-rev7.stp";
const LEAKS = /secret|bracket|tube|\.stp/i;
const ISSUE_PAGE = "https://github.com/mkofler96/KoFEM/issues/new";
// The lines formatDiagnostics writes, in order.
const LINE_LABELS = [
  "KoFEM",
  "Engine",
  "Browser",
  "WebAssembly",
  "WebGL",
  "Model",
  "Step",
  "Last error",
];

async function stubGitHub(page: Page) {
  await page.context().route(/^https:\/\/github\.com\//, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>GitHub (stub)</title>",
    }),
  );
}

function nodeCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: { getState(): { nodes: unknown[] } };
        }
      ).__kofemStore.getState().nodes.length,
  );
}

async function openReport(page: Page) {
  await page.getByTestId("feedback-button").click();
  await page.getByRole("menuitem", { name: /Report a problem/ }).click();
  await expect(page.getByTestId("feedback-dialog")).toBeVisible();
}

// Follow a link that opens in a new tab and return the URL it opened.
async function urlOpenedBy(page: Page, testId: string): Promise<URL> {
  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByTestId(testId).click(),
  ]);
  await tab.waitForURL(/^https:\/\/github\.com\//);
  const url = new URL(tab.url());
  await tab.close();
  return url;
}

test("a problem report previews its diagnostics and opens the prefilled bug form without model data", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await stubGitHub(page);
  await gotoApp(page);
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles({
    name: SECRET_FILE,
    mimeType: "application/octet-stream",
    buffer: TUBE,
  });
  const meshButton = page.getByRole("button", { name: /Mesh STEP volume/ });
  await expect(meshButton).toBeVisible({ timeout: 60_000 });

  // A refused element size puts a real error on screen; it is the last one the
  // report sees, even after the banner is gone.
  const maxSize = page.getByTestId("max-element-size");
  const suggested = await maxSize.inputValue();
  await maxSize.fill("0");
  await meshButton.click();
  const meshError = page.getByTestId("meshing-error").locator("span");
  await expect(meshError).toBeVisible();
  const shownError = (await meshError.textContent())?.trim();
  if (!shownError) throw new Error("the meshing error banner shows no text");

  await maxSize.fill(suggested);
  await meshButton.click();
  await expect
    .poll(() => nodeCount(page), { timeout: 90_000 })
    .toBeGreaterThan(0);
  const nodes = await nodeCount(page);

  await openReport(page);
  const include = page.getByTestId("feedback-include");
  await expect(include).not.toBeChecked();
  const preview = (await page.getByTestId("feedback-diagnostics").innerText())
    .trim()
    .split("\n");
  expect(preview.map((line) => line.split(":")[0])).toEqual(LINE_LABELS);
  expect(preview).toContain("WebAssembly: available");
  expect(preview.find((l) => l.startsWith("Model:"))).toMatch(
    new RegExp(`^Model: 1 body, ${nodes} nodes, \\d+ elements, 0 supports`),
  );
  expect(preview).toContain(`Last error: ${shownError}`);
  expect(preview.join("\n")).not.toMatch(LEAKS);

  // Opted in: the form opens with exactly the previewed text in its field.
  await include.check();
  const withDiagnostics = await urlOpenedBy(page, "feedback-continue");
  expect(`${withDiagnostics.origin}${withDiagnostics.pathname}`).toBe(
    ISSUE_PAGE,
  );
  expect([...withDiagnostics.searchParams.keys()]).toEqual([
    "template",
    "diagnostics",
  ]);
  expect(withDiagnostics.searchParams.get("template")).toBe("bug_report.yml");
  expect(withDiagnostics.searchParams.get("diagnostics")).toBe(
    preview.join("\n"),
  );
  expect(decodeURIComponent(withDiagnostics.href)).not.toMatch(LEAKS);
  // Continuing hands over to GitHub and closes the dialog.
  await expect(page.getByTestId("feedback-dialog")).toBeHidden();

  // Not opted in (the default): the form opens empty.
  await openReport(page);
  const bare = await urlOpenedBy(page, "feedback-continue");
  expect(bare.href).toBe(`${ISSUE_PAGE}?template=bug_report.yml`);
});

test("an error shown in the UI reaches the preview with names and coordinates redacted", async ({
  page,
}) => {
  await gotoApp(page);
  // A material the user named, and an error quoting a coupling name the way
  // lib/coupling.ts does, next to a file name and a coordinate triple.
  await page.evaluate(() => {
    const store = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            materials: { name: string }[];
            setStepImportError(msg: string | null): void;
          };
          setState(partial: Record<string, unknown>): void;
        };
      }
    ).__kofemStore;
    store.setState({
      materials: store
        .getState()
        .materials.map((m) => ({ ...m, name: "ACME alloy X" })),
    });
    store
      .getState()
      .setStepImportError(
        'Could not read secret-bracket-rev7.step: Coupling "ACME_Secret_Project" on ACME alloy X near (12.5, 3, -4)',
      );
  });
  await expect(page.getByTestId("step-error")).toBeVisible();

  await openReport(page);
  const preview = await page.getByTestId("feedback-diagnostics").innerText();
  expect(preview).toContain(
    'Last error: Could not read [file]: Coupling "[redacted]" on [name] near [coordinates]',
  );
  expect(preview).toContain("Model: 0 bodies, 0 nodes, 0 elements");
  expect(preview).not.toMatch(/secret|ACME|12\.5/i);

  // Escape closes the dialog without opening anything.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("feedback-dialog")).toBeHidden();
});

test("Suggest an improvement opens the feature form with nothing else attached", async ({
  page,
}) => {
  await stubGitHub(page);
  await gotoApp(page);
  const button = page.getByRole("button", { name: "Feedback" });
  await expect(button).toBeVisible();

  await button.click();
  await expect(page.getByTestId("feedback-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("feedback-menu")).toBeHidden();

  await button.click();
  const url = await urlOpenedBy(page, "feedback-suggest");
  expect(url.href).toBe(`${ISSUE_PAGE}?template=feature_request.yml`);
  await expect(page.getByTestId("feedback-menu")).toBeHidden();
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "fs";
import type { Page } from "@playwright/test";
import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";
import { readZip } from "../src/lib/zip";

// KOF-265: the top bar's Feedback entry leads to the GitHub issue forms. KoFEM
// sends nothing itself; a public report carries diagnostics only when the user
// ticks them in, and never geometry, file names or results. github.com is
// stubbed, so the test only inspects the URL the app opens. The diagnostics
// builder is unit-tested in tests/unit/feedback.test.mjs.
//
// KOF-202: "Report a problem" saves a report ZIP (analysis, CAD file unless
// left out, versions, log, last error) and opens the email program addressed
// to support@kofem.org; the Load button opens the ZIP again. The ZIP format is
// unit-tested in tests/integration/bug-report.test.mjs.

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

// The public GitHub path is folded below the email report.
async function showGitHub(page: Page) {
  await page.getByText("Report publicly on GitHub instead").click();
  await expect(page.getByTestId("feedback-include")).toBeVisible();
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

test("a problem report previews its diagnostics and opens the prefilled bug form without model data @pipeline", async ({
  page,
}) => {
  await stubGitHub(page);
  await gotoApp(page);
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles({
    name: SECRET_FILE,
    mimeType: "application/octet-stream",
    buffer: TUBE,
  });
  const meshButton = page.getByRole("button", { name: /Generate mesh/ });
  await expect(meshButton).toBeVisible();

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
  await expect.poll(() => nodeCount(page)).toBeGreaterThan(0);
  const nodes = await nodeCount(page);

  await openReport(page);
  await showGitHub(page);
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
  await showGitHub(page);
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
  await showGitHub(page);
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

// The mail link the app hands to the email program, recorded instead of
// followed: a headless browser has no email program.
async function recordMailto(page: Page) {
  await page.evaluate(() => {
    const opened: string[] = [];
    (window as unknown as { __mailto: string[] }).__mailto = opened;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.href.startsWith("mailto:")) opened.push(this.href);
      else click.call(this);
    };
  });
}

function mailtoOpened(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __mailto: string[] }).__mailto,
  );
}

async function saveReport(page: Page, testId: string) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId(testId).click(),
  ]);
  const file = await download.path();
  return {
    name: download.suggestedFilename(),
    file,
    entries: await readZip(new Uint8Array(readFileSync(file))),
  };
}

test("Report a problem saves a report with the CAD file, opens the email to support, and the report reopens", async ({
  page,
}) => {
  await gotoApp(page);
  await page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles({
    name: SECRET_FILE,
    mimeType: "application/octet-stream",
    buffer: TUBE,
  });
  await expect(page.getByRole("button", { name: /Generate mesh/ })).toBeVisible(
    {},
  );
  await recordMailto(page);

  await openReport(page);
  await expect(page.getByTestId("feedback-dialog")).toContainText(
    "support@kofem.org",
  );
  await expect(page.getByTestId("report-contents")).toContainText(
    "Your CAD file",
  );
  const report = await saveReport(page, "report-save");
  expect(report.name).toMatch(/^kofem-report-(?:[\w-]+-)?\d{8}-\d{4}\.zip$/);
  expect(report.entries.map((e) => e.name)).toEqual([
    "report.json",
    "analysis.vtu",
    "geometry.step",
    "log.txt",
  ]);
  const cad = report.entries.find((e) => e.name === "geometry.step");
  expect(Buffer.from(cad?.data ?? []).equals(TUBE)).toBe(true);
  const manifestEntry = report.entries.find((e) => e.name === "report.json");
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestEntry?.data),
  ) as Record<string, unknown>;
  expect(manifest).toMatchObject({
    format: "kofem-report",
    version: 1,
    webAssembly: true,
    cad: { file: "geometry.step", format: "step" },
  });

  // The email program opens addressed to support, naming the file to attach.
  const saved = page.getByTestId("report-saved");
  await expect(saved).toContainText(report.name);
  const mailto = await page.getByTestId("report-mailto").getAttribute("href");
  expect(await mailtoOpened(page)).toEqual([mailto]);
  const mail = new URL(mailto ?? "");
  expect(mail.protocol).toBe("mailto:");
  expect(mail.pathname).toBe("support@kofem.org");
  expect(mail.searchParams.get("body")).toContain(report.name);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("feedback-dialog")).toBeHidden();

  // Without CAD: the same report minus the CAD file.
  await openReport(page);
  const bare = await saveReport(page, "report-without-cad");
  expect(bare.entries.map((e) => e.name)).toEqual([
    "report.json",
    "analysis.vtu",
    "log.txt",
  ]);
  await page.getByRole("button", { name: "Done" }).click();

  // The report reopens: the geometry and its CAD file are back, so the model
  // can be meshed again.
  await page.evaluate(() =>
    (
      window as unknown as { __kofemStore: { getState(): { reset(): void } } }
    ).__kofemStore
      .getState()
      .reset(),
  );
  await page.getByTestId("load-analysis-input").setInputFiles(report.file);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const store = (
          window as unknown as {
            __kofemStore: {
              getState(): {
                stepBytes: Uint8Array | null;
                stepSurface: object | null;
                geometryFormat: string;
              };
            };
          }
        ).__kofemStore.getState();
        return {
          cadBytes: store.stepBytes?.length ?? 0,
          surface: store.stepSurface !== null,
          format: store.geometryFormat,
        };
      }),
    )
    .toEqual({ cadBytes: TUBE.length, surface: true, format: "step" });
});

test("a ZIP that is not a KoFEM report is refused with the reason", async ({
  page,
}) => {
  let dialogMessage = "";
  page.on("dialog", async (d) => {
    dialogMessage = d.message();
    await d.dismiss();
  });
  await gotoApp(page);
  // An empty ZIP: just the end record.
  const empty = Buffer.alloc(22);
  empty.writeUInt32LE(0x06054b50, 0);
  const local = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  await page.getByTestId("load-analysis-input").setInputFiles({
    name: "other.zip",
    mimeType: "application/zip",
    buffer: Buffer.concat([local, empty]),
  });
  await expect
    .poll(() => dialogMessage)
    .toContain("not a KoFEM problem report");
});

test("a report carries only the current model's log, not one from before New analysis @pipeline", async ({
  page,
}) => {
  page.on("dialog", async (d) => {
    await d.accept();
  });
  await gotoApp(page);
  const importTube = () =>
    page.locator('input[type="file"][accept=".stp,.step"]').setInputFiles({
      name: SECRET_FILE,
      mimeType: "application/octet-stream",
      buffer: TUBE,
    });
  await importTube();
  const meshButton = page.getByRole("button", { name: /Generate mesh/ });
  await expect(meshButton).toBeVisible();
  await meshButton.click();
  await expect.poll(() => nodeCount(page)).toBeGreaterThan(0);
  await recordMailto(page);

  const logOf = (entries: { name: string; data: Uint8Array }[]) =>
    new TextDecoder().decode(entries.find((e) => e.name === "log.txt")?.data);

  await openReport(page);
  const meshed = await saveReport(page, "report-save");
  expect(logOf(meshed.entries)).toContain("== mesh ==");
  await page.getByRole("button", { name: "Done" }).click();

  // A new analysis with a new part: the old mesh log is gone from the report.
  await page.getByRole("button", { name: "New analysis" }).click();
  await importTube();
  await expect(page.getByRole("button", { name: /Generate mesh/ })).toBeVisible(
    {},
  );
  await openReport(page);
  const fresh = await saveReport(page, "report-save");
  expect(logOf(fresh.entries)).toBe("(no log)\n");
});

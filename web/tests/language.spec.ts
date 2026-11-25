// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Page } from "@playwright/test";
import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";

// The app speaks English, German, French, Italian, Spanish and Portuguese
// (KOF-468). It opens in the browser's language when it speaks it, and a
// language picked in Settings is kept for the next visit.

test("opens in English for an English browser", async ({ page }) => {
  await gotoApp(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("button", { name: "New analysis" }),
  ).toBeVisible();
});

test.describe("German browser", () => {
  test.use({ locale: "de-DE" });

  test("opens in German", async ({ page }) => {
    await gotoApp(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "de");
    await expect(
      page.getByRole("button", { name: "Neue Analyse" }),
    ).toBeVisible();
    await expect(page.locator("nav")).toContainText("Geometrie");
  });
});

test("a language chosen in Settings is kept after a reload", async ({
  page,
}) => {
  await gotoApp(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Language").selectOption("fr");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(
    page.getByRole("button", { name: "Nouvelle analyse" }),
  ).toBeVisible();

  await page.reload();
  await expect(page.locator("nav")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Nouvelle analyse" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Paramètres" }).click();
  await expect(page.getByLabel("Langue")).toHaveValue("fr");
});

// Every label follows a switch at once, memoised ones too: the app switched
// to German reads exactly as the app opened in German.
async function openExample(page: Page, id: string): Promise<string> {
  await page.goto(`/app/?example=${id}`);
  await expect(page.locator("nav")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __kofemStore: { getState(): { elements: unknown[] } };
            }
          ).__kofemStore.getState().elements.length,
      ),
    )
    .toBeGreaterThan(0);
  // The status bar names the engine's loading phase; both pages are compared
  // once it has loaded.
  await expect(page.getByTestId("engine-status")).toHaveAttribute(
    "data-phase",
    "ready",
  );
  return page.locator("#root").innerText();
}

for (const id of ["axial-bar", "cantilever-beam"]) {
  test(`switching to German relabels everything in the ${id} example`, async ({
    browser,
  }) => {
    const english = await browser.newContext({ locale: "en-US" });
    const switched = await english.newPage();
    await openExample(switched, id);
    await switched.getByRole("button", { name: "Settings" }).click();
    await switched.getByLabel("Language").selectOption("de");
    await switched.keyboard.press("Escape");

    const german = await browser.newContext({ locale: "de-DE" });
    const opened = await german.newPage();
    const expected = await openExample(opened, id);

    await expect(switched.locator("#root")).toHaveText(expected, {
      useInnerText: true,
    });
    await english.close();
    await german.close();
  });
}

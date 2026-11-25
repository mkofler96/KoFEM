// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Browser, Page } from "@playwright/test";
import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";
import { buildCantilever } from "./fixtures/cantilever";

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

// Only the visitor's language travels on the first load (KOF-471): every
// script the page and the solver worker fetch, read for the "New analysis"
// button's text in each language.
const NEW_ANALYSIS = {
  en: "New analysis",
  de: "Neue Analyse",
  fr: "Nouvelle analyse",
  it: "Nuova analisi",
  es: "Nuevo análisis",
  pt: "Nova análise",
} as const;
type Language = keyof typeof NEW_ANALYSIS;

async function languagesLoaded(
  browser: Browser,
  browserLocale: string,
): Promise<Language[]> {
  const context = await browser.newContext({ locale: browserLocale });
  const scripts: Promise<string>[] = [];
  context.on("response", (response) => {
    if (response.url().endsWith(".js")) scripts.push(response.text());
  });
  const page = await context.newPage();
  await gotoApp(page);
  await expect(page.getByTestId("engine-status")).toHaveAttribute(
    "data-phase",
    "ready",
  );
  const texts = await Promise.all(scripts);
  await context.close();
  return (Object.keys(NEW_ANALYSIS) as Language[]).filter((language) =>
    texts.some((text) => text.includes(NEW_ANALYSIS[language])),
  );
}

test("an English browser downloads only the English messages", async ({
  browser,
}) => {
  expect(await languagesLoaded(browser, "en-US")).toEqual(["en"]);
});

test("a German browser downloads only the English and German messages", async ({
  browser,
}) => {
  expect(await languagesLoaded(browser, "de-DE")).toEqual(["en", "de"]);
});

test("a language that fails to load at start is reported, not replaced by English", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "de-DE" });
  await context.route(/\/assets\/de-[\w-]+\.js$/, (route) => route.abort());
  const page = await context.newPage();
  await page.goto("/app/");
  await expect(page.getByRole("alert")).toContainText("Deutsch");
  await expect(page.locator("nav")).toHaveCount(0);
  await expect(page.getByText(NEW_ANALYSIS.en)).toHaveCount(0);
  await context.close();
});

test("a language that fails to load in Settings is reported, and the current one stays", async ({
  page,
}) => {
  await page.route(/\/assets\/it-[\w-]+\.js$/, (route) => route.abort());
  await gotoApp(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Language").selectOption("it");
  await expect(page.getByRole("alert")).toContainText("Italiano");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByLabel("Language")).toHaveValue("en");
  await expect(
    page.getByRole("button", { name: NEW_ANALYSIS.en }),
  ).toBeVisible();
});

// The solver worker fetches its own copy of a language (KOF-471): a model
// with no supports, refused in the language just picked in Settings.
test("the solver worker refuses in the language picked in Settings", async ({
  page,
}) => {
  await gotoApp(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Language").selectOption("de");
  await expect(page.locator("html")).toHaveAttribute("lang", "de");

  const unsupported = { ...buildCantilever(), constraints: [] };
  const refusal = await page.evaluate(async (model) => {
    const kofem = (
      window as unknown as {
        __kofem: {
          sendToWorker(name: string, payload: object): Promise<unknown>;
        };
      }
    ).__kofem;
    try {
      await kofem.sendToWorker("solve", {
        solverMethod: "gauss-seidel",
        ...model,
      });
      return "solved";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, unsupported);
  expect(refusal).toContain("Körper 1 kann sich noch");
  expect(refusal).toContain("Fügen Sie eine Lagerung hinzu");
});

// A chunk the test releases: requests matching it wait until `open()`.
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

test("the last language picked in Settings wins over a slower earlier pick", async ({
  page,
}) => {
  const german = gate();
  await page.route(/\/assets\/de-[\w-]+\.js$/, async (route) => {
    await german.opened;
    await route.continue();
  });
  await gotoApp(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Language").selectOption("de");
  await page.getByLabel("Language").selectOption("fr");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");

  const germanLoaded = page.waitForResponse(/\/assets\/de-[\w-]+\.js$/);
  german.open();
  const chunk = (await germanLoaded).url();
  // Importing the chunk again resolves once the app's own import has run it
  // and the switch it started has settled.
  await page.evaluate((url) => import(url), chunk);
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  await expect(page.getByLabel("Langue")).toHaveValue("fr");
});

test("an engine that fails before the language arrives is reported once it has", async ({
  browser,
}) => {
  const context = await browser.newContext({ locale: "de-DE" });
  // Marks the page once the worker reports the failed engine start.
  await context.addInitScript(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener("message", (e: MessageEvent) => {
          const data = e.data as { engineStatus?: { phase: string } };
          if (data.engineStatus?.phase === "failed")
            (window as unknown as { __engineFailed: boolean }).__engineFailed =
              true;
        });
      }
    };
  });
  await context.route(/kofem_wasm_emcc[^/]*\.wasm$/, (route) =>
    route.abort("failed"),
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route(/\/assets\/de-[\w-]+\.js$/, async (route) => {
    await page.waitForFunction(
      () => (window as unknown as { __engineFailed?: boolean }).__engineFailed,
    );
    await route.continue();
  });
  await page.goto("/app/");
  const error = page.getByTestId("engine-error");
  await expect(error).toContainText("Download blockiert");
  expect(errors).toEqual([]);
  await context.close();
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Page } from "@playwright/test";
import { test, expect } from "./coverage";
import { importStep } from "./fixtures/app";
import { openTree } from "./fixtures/tree";

// The consent-gated GA4 loader (vite-analytics.ts) and the product events
// behind it (src/lib/analytics.ts). The test build carries no measurement ID,
// so each page's HTML gets one the way the Docker entrypoint fills it in, and
// Google's endpoints are stubbed: nothing here talks to Google, and every
// request that would have is recorded.

const GA_ID = "G-TEST000000";
const PAGES = [
  "/",
  "/app/",
  "/examples/",
  "/privacy/",
  "/validation/",
  "/validation/axial-bar/",
];
const CONSENT_KEY = "kofem_analytics_consent";

interface GaEvent {
  name: string;
  params: Record<string, string>;
}

// Enable the loader on every page and record what would have gone to Google.
async function withAnalytics(page: Page): Promise<string[]> {
  const googleRequests: string[] = [];
  await page.route(
    (url) =>
      url.hostname === "localhost" &&
      (url.pathname.endsWith("/") || url.pathname.endsWith(".html")),
    async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replaceAll("__KOFEM_GA_ID__", GA_ID);
      await route.fulfill({ response, body: html });
    },
  );
  await page.route(
    /googletagmanager\.com|google-analytics\.com/,
    async (route) => {
      googleRequests.push(route.request().url());
      await route.fulfill({
        contentType: "application/javascript",
        body: "/* gtag.js stub */",
      });
    },
  );
  return googleRequests;
}

function setConsent(page: Page, choice: "granted" | "denied") {
  return page.addInitScript(
    ([key, value]) => localStorage.setItem(key, value),
    [CONSENT_KEY, choice],
  );
}

// What the page handed to gtag, read back from the dataLayer.
function gaCalls(page: Page): Promise<unknown[][]> {
  return page.evaluate(() =>
    ((window as Window & { dataLayer?: IArguments[] }).dataLayer ?? []).map(
      (args) => JSON.parse(JSON.stringify(Array.from(args))) as unknown[],
    ),
  );
}

async function gaEvents(page: Page): Promise<GaEvent[]> {
  return (await gaCalls(page))
    .filter((call) => call[0] === "event")
    .map((call) => ({
      name: call[1] as string,
      params: call[2] as Record<string, string>,
    }));
}

async function eventNames(page: Page): Promise<string[]> {
  return (await gaEvents(page)).map((e) => e.name);
}

// The static study panel registers the solve hook once it is open.
async function triggerSolve(page: Page) {
  await openTree(page, "static");
  await page.waitForFunction(
    () =>
      typeof (window as Window & { __kofemTriggerSolve?: () => void })
        .__kofemTriggerSolve === "function",
  );
  await page.evaluate(() => {
    const trigger = (window as Window & { __kofemTriggerSolve?: () => void })
      .__kofemTriggerSolve;
    if (!trigger) throw new Error("__kofemTriggerSolve is not registered");
    trigger();
  });
}

const banner = (page: Page) =>
  page.getByRole("dialog", { name: "Cookie consent" });

test.describe("consent", () => {
  test("unanswered: every page asks, and nothing loads", async ({ page }) => {
    const googleRequests = await withAnalytics(page);
    for (const path of PAGES) {
      await page.goto(path);
      await expect(banner(page)).toBeVisible();
      expect(
        await page.evaluate(() => typeof (window as { gtag?: unknown }).gtag),
      ).toBe("undefined");
    }
    expect(googleRequests).toEqual([]);
  });

  test("declined: no request to Google on any page", async ({ page }) => {
    const googleRequests = await withAnalytics(page);
    await page.goto("/app/");
    await banner(page).getByRole("button", { name: "Decline" }).click();
    await expect(banner(page)).toBeHidden();
    expect(
      await page.evaluate(
        (id) =>
          (window as unknown as Record<string, unknown>)[`ga-disable-${id}`],
        GA_ID,
      ),
    ).toBe(true);
    for (const path of PAGES) {
      await page.goto(path);
      await expect(banner(page)).toBeHidden();
    }
    expect(await gaCalls(page)).toEqual([]);
    expect(googleRequests).toEqual([]);
  });

  test("accepted: every page loads gtag.js and records a page view", async ({
    page,
  }) => {
    const googleRequests = await withAnalytics(page);
    await setConsent(page, "granted");
    for (const path of PAGES) {
      await page.goto(path);
      await expect(banner(page)).toBeHidden();
      const config = (await gaCalls(page)).find((c) => c[0] === "config");
      expect(config, `gtag config on ${path}`).toEqual([
        "config",
        GA_ID,
        {
          allow_google_signals: false,
          allow_ad_personalization_signals: false,
        },
      ]);
    }
    expect(googleRequests).toHaveLength(PAGES.length);
    expect(googleRequests.every((u) => u.includes(`id=${GA_ID}`))).toBe(true);
  });

  test("accepting in the app sends what happened while the banner was open", async ({
    page,
  }) => {
    const googleRequests = await withAnalytics(page);
    await page.goto("/app/");
    await expect(page.locator("nav")).toBeVisible();
    expect(googleRequests).toEqual([]);

    await banner(page).getByRole("button", { name: "Accept" }).click();
    await expect.poll(() => eventNames(page)).toContain("solver_opened");
    const opened = (await gaEvents(page)).find(
      (e) => e.name === "solver_opened",
    );
    expect(opened?.params.entry).toBe("direct");
    expect(googleRequests).toHaveLength(1);
  });

  test("withdrawn in the app: cookies go and later events are not sent", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await withAnalytics(page);
    await setConsent(page, "granted");
    await page.goto("/app/");
    await expect.poll(() => eventNames(page)).toContain("solver_opened");
    await page.evaluate(() => {
      for (const cookie of ["_ga=GA1.1.123.456", "_ga_TEST000000=GS1.1.789"])
        document.cookie = `${cookie}; path=/`;
    });

    await page.getByRole("link", { name: "Cookie settings" }).click();
    await banner(page).getByRole("button", { name: "Decline" }).click();
    expect(await page.evaluate(() => document.cookie)).not.toContain("_ga");
    const before = await eventNames(page);

    // An empty model: solve_started is emitted at once, solve_failed when the
    // worker answers.
    await triggerSolve(page);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __kofemStore: { getState(): { isRunning: boolean } };
                }
              ).__kofemStore.getState().isRunning,
          ),
        { timeout: 45_000 },
      )
      .toBe(false);
    expect(await eventNames(page)).toEqual(before);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("kofem_analytics_consent"),
      ),
    ).toBe("denied");
  });

  test("without a measurement ID the app offers no cookie settings", async ({
    page,
  }) => {
    await page.goto("/app/");
    await expect(page.locator("nav")).toBeVisible();
    await expect(banner(page)).toBeHidden();
    await expect(
      page.getByRole("link", { name: "Cookie settings" }),
    ).toHaveCount(0);
  });
});

test.describe("workflow events", () => {
  test("example: loaded, results viewed, re-solved", async ({ page }) => {
    test.setTimeout(90_000);
    await withAnalytics(page);
    await setConsent(page, "granted");
    await page.goto("/app/?example=cantilever-beam");

    await expect
      .poll(() => eventNames(page), { timeout: 15_000 })
      .toEqual(
        expect.arrayContaining([
          "solver_opened",
          "example_loaded",
          "results_viewed",
        ]),
      );
    const events = await gaEvents(page);
    expect(events.find((e) => e.name === "solver_opened")?.params.entry).toBe(
      "example",
    );
    expect(
      events.find((e) => e.name === "example_loaded")?.params.example_id,
    ).toBe("cantilever-beam");
    expect(
      events.find((e) => e.name === "results_viewed")?.params.workflow,
    ).toBe("example");

    await triggerSolve(page);
    await expect
      .poll(() => eventNames(page), { timeout: 60_000 })
      .toContain("solve_completed");
    const after = await gaEvents(page);
    const started = after.find((e) => e.name === "solve_started");
    const completed = after.find((e) => e.name === "solve_completed");
    expect(started?.params).toEqual({
      workflow: "example",
      analysis_type: "static",
    });
    expect(completed?.params.workflow).toBe("example");
    expect(completed?.params.duration_bucket).toMatch(/^[a-z0-9_]+$/);
    expect(after.map((e) => e.name)).toContain("engine_ready");
    expect(after.map((e) => e.name)).not.toContain("solve_failed");
  });

  test("CAD import: failure and success are told apart, nothing about the file is sent", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await withAnalytics(page);
    await setConsent(page, "granted");

    await page.goto("/app/");
    await page
      .locator('input[type="file"][accept=".stp,.step"]')
      .setInputFiles({
        name: "secret-bracket-rev7.stp",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("this is not a STEP file"),
      });
    await expect
      .poll(() => eventNames(page), { timeout: 45_000 })
      .toContain("geometry_import_failed");
    const failed = (await gaEvents(page)).find(
      (e) => e.name === "geometry_import_failed",
    );
    expect(failed?.params.format).toBe("step");
    expect(failed?.params.error_category).toBe("unsupported_format");

    await importStep(page, "tests/fixtures/tube.stp");
    await expect
      .poll(() => eventNames(page), { timeout: 15_000 })
      .toContain("geometry_import_success");

    // A refused element size is a mesh failure caused by the input.
    const maxSize = page.getByTestId("max-element-size");
    const suggested = await maxSize.inputValue();
    await maxSize.fill("0");
    await page.getByRole("button", { name: /Mesh STEP volume/ }).click();
    await expect.poll(() => eventNames(page)).toContain("mesh_failed");
    const meshFailed = (await gaEvents(page)).find(
      (e) => e.name === "mesh_failed",
    );
    expect(meshFailed?.params).toMatchObject({
      workflow: "cad_import",
      model_type: "solid",
      error_category: "invalid_input",
    });

    await maxSize.fill(suggested);
    await page.getByRole("button", { name: /Mesh STEP volume/ }).click();
    await expect
      .poll(() => eventNames(page), { timeout: 90_000 })
      .toContain("mesh_completed");
    const meshed = (await gaEvents(page)).find(
      (e) => e.name === "mesh_completed",
    );
    expect(meshed?.params).toMatchObject({
      workflow: "cad_import",
      model_type: "solid",
    });

    const everything = JSON.stringify(await gaCalls(page));
    expect(everything).not.toMatch(/secret|bracket|tube|\.stp/i);
  });
});

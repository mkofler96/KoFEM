// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { chromium, defineConfig } from "@playwright/test";
import fs from "fs";
import { resolveChromiumExecutable } from "./playwright-browser";

// The browser suite: `just test-e2e`. What needs no browser is a bun test
// (tests/unit, tests/integration; `just test-web`), not a spec here.
//
// Two projects, split by what a test costs:
//
//   ui        interaction on small prepared models. A test has seconds of
//             work; the timing-sensitive ones (picking, races) live here.
//   pipeline  tests tagged @pipeline in their title: a real CAD import, a
//             mesh of a real part, a full STEP-to-result flow. CI runs them
//             in jobs of their own, so a `ui` test never shares a runner
//             with a mesher.
//
// Time budgets are set here, once per project, and nowhere else. They are
// watchdogs for a hung page, not performance targets: an assertion returns as
// soon as its condition holds, so a generous budget costs nothing when a test
// passes. A test that outgrows the `ui` budget belongs in `pipeline`; neither
// project wants a per-test number (the lint rule kofem/no-test-timeouts).

const CI = Boolean(process.env.CI);

// The pinned headless shell where installed (CI), else the pre-installed
// Chromium of a cloud session; see playwright-browser.ts.
const executablePath = resolveChromiumExecutable({
  env: process.env,
  pinnedChromium: chromium.executablePath(),
  exists: (file) => fs.existsSync(file),
});

export default defineConfig({
  testDir: "./tests",
  // bun owns *.test.*; Playwright runs the specs only.
  testMatch: "**/*.spec.ts",
  outputDir: "./playwright-results",
  // Schedule tests one by one, not file by file, so CI shards cut evenly.
  fullyParallel: true,
  forbidOnly: CI,
  // On CI a failing test gets two more attempts. One that then passes is
  // reported as flaky, with the trace of its first retry, and the run stays
  // green: a pull request is not held up by a failure it did not cause. The
  // nightly flake hunt (.github/workflows/flake-hunt.yml) runs without
  // retries, so such a test is found and fixed rather than tolerated.
  // Locally there are none: a failure is yours to look at.
  retries: CI ? 2 : 0,
  // A hosted runner has four cores. Each test drives a page, a solver worker
  // and software WebGL, so two tests at a time is what fits.
  workers: CI ? 2 : undefined,
  // A broken build fails fast instead of timing out one test after another.
  maxFailures: CI ? 15 : undefined,
  reporter: CI
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:4173",
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: "ui",
      // @capture: the on-demand figure capture, which writes committed PNGs
      // and would churn them on a routine run (playwright.capture.config.ts).
      grepInvert: /@pipeline|@capture/,
      timeout: 120_000,
      expect: { timeout: 30_000 },
    },
    {
      name: "pipeline",
      grep: /@pipeline/,
      grepInvert: /@capture/,
      timeout: 600_000,
      expect: { timeout: 240_000 },
    },
  ],
  webServer: {
    command: "bun run build:dev && bun run preview",
    url: "http://localhost:4173",
    reuseExistingServer: !CI,
    timeout: 300_000,
  },
});

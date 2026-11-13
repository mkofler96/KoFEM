// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { chromium, defineConfig } from "@playwright/test";
import fs from "fs";
import { resolveChromiumExecutable } from "./playwright-browser";

// The pinned headless shell where installed (CI), else the pre-installed
// Chromium of a cloud session; see playwright-browser.ts.
const executablePath = resolveChromiumExecutable({
  env: process.env,
  pinnedChromium: chromium.executablePath(),
  exists: (file) => fs.existsSync(file),
});

export default defineConfig({
  testDir: "./tests",
  // tests/unit holds bun test files (bun run test:validation runs them);
  // their *.test.* names would otherwise match Playwright's default pattern.
  testIgnore: "unit/**",
  outputDir: "./playwright-results",
  timeout: 30_000,
  // Schedule tests one by one, not file by file. CI splits the suite with
  // --shard, which cuts by test count: with whole files, one shard drew the
  // slow solver files and ran ~3x longer than the lightest one.
  fullyParallel: true,
  // Default suite runs everything except the on-demand figure capture (tagged
  // @capture), which writes committed PNGs and would otherwise churn them on a
  // routine `bun run test`. Run it with `bun run capture:tutorial`.
  grepInvert: /@capture/,
  use: {
    baseURL: "http://localhost:4173",
    headless: true,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: "bun run build:dev && bun run preview",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

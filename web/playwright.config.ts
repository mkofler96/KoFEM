// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from "@playwright/test";
import fs from "fs";

// Fall back to the pre-installed chromium when the headless-shell isn't available
const FALLBACK_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const executablePath = fs.existsSync(FALLBACK_CHROME)
  ? FALLBACK_CHROME
  : undefined;

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

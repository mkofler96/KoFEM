import { defineConfig } from "@playwright/test";
import fs from "fs";

// Fall back to the pre-installed chromium when the headless-shell isn't available
const FALLBACK_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const executablePath = fs.existsSync(FALLBACK_CHROME)
  ? FALLBACK_CHROME
  : undefined;

export default defineConfig({
  testDir: "./tests",
  outputDir: "./playwright-results",
  timeout: 30_000,
  // Default suite runs everything except the on-demand capture tests, which
  // write committed assets and would otherwise churn them on a routine
  // `bun run test`: @capture writes the tutorial PNGs (`bun run capture:tutorial`)
  // and @video writes the walkthrough video (`bun run capture:video`).
  grepInvert: /@capture|@video/,
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

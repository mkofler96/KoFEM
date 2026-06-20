import { defineConfig } from "@playwright/test";
import fs from "fs";

// Fall back to the pre-installed chromium when the headless-shell isn't available
const FALLBACK_CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const executablePath = fs.existsSync(FALLBACK_CHROME)
  ? FALLBACK_CHROME
  : undefined;

export default defineConfig({
  testDir: "./tests",
  // tutorial-capture writes committed figures into public/tutorial/; keep it out
  // of the routine suite so `bun run test` doesn't churn them. Run it explicitly
  // with `bun run capture:tutorial`.
  testIgnore: "**/tutorial-capture.spec.ts",
  outputDir: "./playwright-results",
  timeout: 30_000,
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

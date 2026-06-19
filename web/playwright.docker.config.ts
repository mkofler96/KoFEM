import { defineConfig } from "@playwright/test";

// Config for the production-image smoke test. It does NOT start its own server:
// CI builds the Docker image, runs the container (nginx serving the production
// bundle on :10000), and points this config at it via SMOKE_BASE_URL. The test
// then drives the full WASM pipeline against the real served artifacts — the
// thing `bun run dev` and the dist preview cannot verify.
export default defineConfig({
  testDir: "./tests",
  testMatch: ["**/production-smoke.spec.ts"],
  outputDir: "./playwright-results",
  timeout: 120_000,
  use: {
    baseURL: process.env.SMOKE_BASE_URL ?? "http://localhost:10000",
    headless: true,
  },
});

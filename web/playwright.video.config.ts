import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// On-demand config for regenerating the committed walkthrough video
// (web/public/tutorial/walkthrough.webm). The base config excludes the @video
// test from the routine suite via grepInvert; here we invert that to run only
// it. Kept out of `bun run test` on purpose — it drives the heavy Wall Bracket
// solve in realtime and records video. Run with `bun run capture:video`.
export default defineConfig({
  ...base,
  grepInvert: undefined,
  grep: /@video/,
});

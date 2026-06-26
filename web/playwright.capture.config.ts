// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// On-demand config for regenerating the committed tutorial figures
// (web/public/tutorial/). The base config excludes the @capture test from the
// routine suite via grepInvert; here we invert that to run only it. Kept out of
// `bun run test` on purpose — it drives the heavy Wall Bracket solve, which is
// too memory-hungry for the CI runners. Run with `bun run capture:tutorial`.
export default defineConfig({
  ...base,
  grepInvert: undefined,
  grep: /@capture/,
});

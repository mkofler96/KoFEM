// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// On-demand config for regenerating committed figures: the tutorial figures
// (web/public/tutorial/, `bun run capture:tutorial`) and the example write-up
// figures (examples/gallery/site/<id>/, `bun run capture:example-pages`). The
// base config excludes the @capture tests from the routine suite via
// grepInvert; here we invert that to run only them. Kept out of `bun run test`
// on purpose — the tutorial drives the heavy Wall Bracket solve, which is too
// memory-hungry for the CI runners, and a routine run must not rewrite PNGs.
export default defineConfig({
  ...base,
  grepInvert: undefined,
  grep: /@capture/,
});

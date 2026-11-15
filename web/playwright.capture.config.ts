// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// On-demand config for regenerating committed figures: the tutorial's
// (web/public/tutorial/, `bun run capture:tutorial`) and the README
// screenshots (web/screenshots/, `bun run capture:readme`). The routine suite
// leaves the @capture tests out; this config runs only them. Kept out of
// `just test-e2e` on purpose — the tutorial drives the heavy Wall Bracket
// solve, which is too memory-hungry for the CI runners, and a routine run
// must not rewrite PNGs.
export default defineConfig({
  ...base,
  projects: [
    {
      name: "capture",
      grep: /@capture/,
      timeout: 600_000,
      expect: { timeout: 240_000 },
      workers: 1,
    },
  ],
});

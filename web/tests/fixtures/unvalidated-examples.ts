// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Serves the analyses in examples/unvalidated/ at the URLs the app's
// `/app/?example=<id>` loader fetches. They are regression fixtures, not
// gallery examples, so they are not in examples/gallery/site/ and kofem.org never ships
// them (examples/unvalidated/crane-hook/README.md).

import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CRANE_DIR = join(here, "../../../examples/unvalidated/crane-hook");

// The coupled crane: thin holder as shells, pin and hook as solids. It carries
// no geometry, which ?example= refuses, so a test opens it as a saved analysis
// file instead.
export const UNVALIDATED_CRANE_SHELL = join(CRANE_DIR, "crane-hook-shell.vtu");

// id → the files the loader asks for: the .vtu, and the STEP it was saved
// from, served as <id>.model.step (the geometry the .vtu's CAD faces refer
// to). The app refuses an example without it.
const FIXTURES: Record<string, { vtu: string; step: string }> = {
  "full-crane-hook": {
    vtu: join(CRANE_DIR, "full-crane-hook.vtu"),
    step: join(here, "../../../test_files/full-crane-hook.step"),
  },
};

export async function serveUnvalidatedExample(
  page: Page,
  id: keyof typeof FIXTURES,
): Promise<void> {
  const files = FIXTURES[id];
  await page.route(`**/examples/${id}.vtu`, async (route) =>
    route.fulfill({
      body: await readFile(files.vtu),
      contentType: "application/xml",
    }),
  );
  await page.route(`**/examples/${id}.model.step`, async (route) =>
    route.fulfill({
      body: await readFile(files.step),
      contentType: "application/octet-stream",
    }),
  );
}

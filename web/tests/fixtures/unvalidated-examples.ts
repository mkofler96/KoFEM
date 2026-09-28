// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Serves the analyses in examples/unvalidated/ at the URLs the app's
// `/app/?example=<id>` loader fetches. They are regression fixtures, not
// gallery examples, so they are not in web/public/ and kofem.org never ships
// them (examples/unvalidated/crane-hook/README.md).

import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CRANE_DIR = join(here, "../../../examples/unvalidated/crane-hook");

// id → the files the loader asks for. The .step is optional in the app (a 404
// just leaves the model non-re-meshable), so only list one where it exists.
const FIXTURES: Record<string, { vtu: string; step?: string }> = {
  "crane-hook-shell": {
    vtu: join(CRANE_DIR, "crane-hook-shell.vtu"),
    step: join(here, "../../../test_files/full-crane-hook.step"),
  },
  "full-crane-hook": { vtu: join(CRANE_DIR, "full-crane-hook.vtu") },
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
  const step = files.step;
  if (step)
    await page.route(`**/examples/${id}.step`, async (route) =>
      route.fulfill({
        body: await readFile(step),
        contentType: "application/octet-stream",
      }),
    );
}

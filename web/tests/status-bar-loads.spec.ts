// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-250: forces and pressures on faces (and shell edges) reach the solver as
// `surfaceLoads`, not nodal `loads`. The status bar counted only nodal load
// DOFs, so a model loaded entirely through faces showed no load count at all.
// These examples ship exactly one force group each and no nodal loads.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";

interface LoadCounts {
  nodalLoadDofs: number;
  surfaceLoads: number;
}

async function openExample(page: Page, example: string): Promise<LoadCounts> {
  await page.goto(`/app/?example=${example}`);
  await expect(page.locator("nav")).toBeVisible();
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __kofemStore?: { getState(): { surfaceLoads: unknown[] } };
        }
      ).__kofemStore?.getState().surfaceLoads.length,
    null,
    { timeout: 15_000 },
  );
  return page.evaluate(() => {
    const state = (
      window as unknown as {
        __kofemStore: {
          getState(): { loads: unknown[]; surfaceLoads: unknown[] };
        };
      }
    ).__kofemStore.getState();
    return {
      nodalLoadDofs: state.loads.length,
      surfaceLoads: state.surfaceLoads.length,
    };
  });
}

for (const [example, body] of [
  ["mbb-beam-topopt", "solid face load"],
  ["plate-with-hole-shell", "shell edge load"],
] as const) {
  test(`status bar counts a ${body} (${example})`, async ({ page }) => {
    const counts = await openExample(page, example);
    expect(counts).toEqual({ nodalLoadDofs: 0, surfaceLoads: 1 });

    await expect(page.getByText("1 face load", { exact: true })).toBeVisible();
    await expect(page.getByText(/load DOFs?$/)).toHaveCount(0);
  });
}

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// "Automatic shell detection" control in the Bodies section: the checkbox turns
// the thin-wall preselection off (every body Solid) and back on, and the thin
// ratio re-runs detection against the imported tessellation. Detection is pure
// geometry, so both act immediately — no re-mesh needed — and per-body material
// assignments must survive (only the discretization is rewritten).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect } from "./coverage";

const here = dirname(fileURLToPath(import.meta.url));
const STEP_PATH = join(here, "../../test_files/fin_two_parts.step");

type Disc = { id: number; discretization?: string; materialId: number }[];

async function bodies(page: import("@playwright/test").Page): Promise<Disc> {
  return (await page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: { getState(): { properties: Disc } };
        }
      ).__kofemStore.getState().properties,
  )) as Disc;
}

test("automatic shell detection can be switched off and its ratio tuned", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto("/app/");
  await expect(page.locator("nav")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __kofem?: unknown }).__kofem),
  );

  await page.setInputFiles('input[accept=".stp,.step"]', STEP_PATH);
  await expect
    .poll(async () => (await bodies(page)).length, { timeout: 60_000 })
    .toBeGreaterThan(1);

  // The 2 mm fin (body 2) is preselected Shell by the default 2 % ratio.
  const initial = await bodies(page);
  expect(initial.some((p) => p.discretization === "shell")).toBe(true);

  const toggle = page.getByTestId("auto-shell-detection");
  await expect(toggle).toBeChecked();

  // Switching detection off makes every body Solid.
  await toggle.uncheck();
  await expect
    .poll(async () =>
      (await bodies(page)).every((p) => p.discretization === "solid"),
    )
    .toBe(true);
  // The ratio input is only offered while detection is on.
  await expect(page.getByTestId("auto-shell-ratio")).toHaveCount(0);

  // Switching it back on restores the Shell preselection.
  await toggle.check();
  await expect
    .poll(async () =>
      (await bodies(page)).some((p) => p.discretization === "shell"),
    )
    .toBe(true);

  // Materials survive a detection re-run (only discretization is rewritten).
  const afterToggle = await bodies(page);
  expect(afterToggle.map((p) => p.materialId)).toEqual(
    initial.map((p) => p.materialId),
  );

  // A far stricter ratio finds no body thin enough — everything falls back to Solid.
  await page.getByTestId("auto-shell-ratio").fill("0.001");
  await expect
    .poll(async () =>
      (await bodies(page)).every((p) => p.discretization === "solid"),
    )
    .toBe(true);
});

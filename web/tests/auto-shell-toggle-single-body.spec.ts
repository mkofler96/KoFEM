// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Single-body parts get the same "Automatic shell detection" control as
// assemblies. The per-body Element type dropdown is offered for assemblies only,
// so for a one-body part the switch and its ratio are the ONLY way to choose
// between a shell and a solid idealisation — they must be reachable there too.
// Both settings are model state, so a re-import honours them instead of falling
// back to detection at the default ratio.
//
// I_beam.step is a 300 mm long 80x80 mm I-section: its ~5 mm flanges are thin
// walls, but not thin enough for the default 2 % of the body diagonal, so it
// imports Solid and turns Shell once the ratio is raised.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect } from "./coverage";

const here = dirname(fileURLToPath(import.meta.url));
const STEP_PATH = join(here, "../../test_files/I_beam.step");

type Disc = { id: number; discretization?: string }[];

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

test("automatic shell detection and its ratio are offered for single-body parts", async ({
  page,
}) => {
  test.setTimeout(180_000);

  await page.goto("/app/");
  await expect(page.locator("nav")).toBeVisible();
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __kofem?: unknown }).__kofem),
  );

  await page.setInputFiles('input[accept=".stp,.step"]', STEP_PATH);
  const toggle = page.getByTestId("auto-shell-detection");
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  await expect(toggle).toBeChecked();

  const initial = await bodies(page);
  expect(initial).toHaveLength(1);
  expect(initial[0].discretization).toBe("solid");

  // The ratio decides which bodies auto-shell: the I-beam's flanges qualify at
  // 5 % of the body diagonal, so the sole body flips to Shell.
  await page.getByTestId("auto-shell-ratio").fill("0.05");
  await expect
    .poll(async () => (await bodies(page))[0].discretization)
    .toBe("shell");

  // Switching detection off is the single-body part's way back to a solid mesh.
  await toggle.uncheck();
  await expect
    .poll(async () => (await bodies(page))[0].discretization)
    .toBe("solid");
  await expect(page.getByTestId("auto-shell-ratio")).toHaveCount(0);

  // Re-importing must not silently switch detection back on.
  await page.setInputFiles('input[accept=".stp,.step"]', STEP_PATH);
  await expect(toggle).not.toBeChecked();
  await expect
    .poll(async () => (await bodies(page))[0].discretization, {
      timeout: 60_000,
    })
    .toBe("solid");

  // Switching it back on re-runs detection at the retained 5 % ratio.
  await toggle.check();
  await expect(page.getByTestId("auto-shell-ratio")).toHaveValue("0.05");
  await expect
    .poll(async () => (await bodies(page))[0].discretization)
    .toBe("shell");
});

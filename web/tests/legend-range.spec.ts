// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";

// Manual colorbar limits (#390): a pre-solved example is enough to exercise the
// whole path — pinning the limits, rejecting an inverted range, the "Auto"
// reset, and the reset that switching result type performs.

function readLegendRange(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: {
            getState(): { legendRange: { min: number; max: number } | null };
          };
        }
      ).__kofemStore.getState().legendRange,
  );
}

async function tickValue(
  page: import("@playwright/test").Page,
  i: number,
): Promise<number> {
  const text = await page.getByTestId(`colorbar-tick-${i}`).innerText();
  return Number(text.replace(/^[≥≤]\s*/, ""));
}

test("the colorbar limits can be pinned, rejected when inverted, and reset (#390)", async ({
  page,
}) => {
  test.setTimeout(60_000);

  await page.goto("/app/?example=cantilever-beam");
  await expect(page.locator("nav")).toBeVisible();
  await expect(page.getByTestId("colorbar")).toBeVisible({ timeout: 20_000 });

  // Auto: the ticks span the field's own min/max and nothing is clamped.
  await expect(page.getByTestId("colorbar-manual")).toHaveCount(0);
  expect(await readLegendRange(page)).toBeNull();
  const fieldMax = await tickValue(page, 0);
  expect(fieldMax).toBeGreaterThan(0);

  // Pinning the top of the range to half the peak: the store carries the
  // override, the colorbar says so, and the top tick reads as a clamp.
  const pinnedMax = fieldMax / 2;
  await page.getByTestId("legend-max").fill(String(pinnedMax));
  await page.getByTestId("legend-max").press("Enter");

  await expect(page.getByTestId("colorbar-manual")).toBeVisible();
  const range = await readLegendRange(page);
  expect(range).not.toBeNull();
  expect(range!.max).toBeCloseTo(pinnedMax, 6);
  await expect(page.getByTestId("colorbar-tick-0")).toContainText("≥");
  expect(await tickValue(page, 0)).toBeCloseTo(pinnedMax, 6);

  // An inverted range is refused loudly and leaves the applied limits alone.
  await page.getByTestId("legend-min").fill(String(fieldMax));
  await page.getByTestId("legend-min").press("Enter");
  await expect(page.getByTestId("legend-error")).toContainText(
    "Max must be greater than min",
  );
  expect((await readLegendRange(page))!.max).toBeCloseTo(pinnedMax, 6);

  // "Auto" hands the range back to the field.
  await page.getByTestId("legend-auto").click();
  expect(await readLegendRange(page)).toBeNull();
  await expect(page.getByTestId("colorbar-manual")).toHaveCount(0);
  expect(await tickValue(page, 0)).toBeCloseTo(fieldMax, 6);

  // Limits picked for one field mean nothing for the next one, so switching
  // result type drops them.
  await page.getByTestId("legend-max").fill(String(pinnedMax));
  await page.getByTestId("legend-max").press("Enter");
  expect(await readLegendRange(page)).not.toBeNull();

  await page.getByRole("combobox").first().selectOption("Ux");
  expect(await readLegendRange(page)).toBeNull();
  await expect(page.getByTestId("colorbar-manual")).toHaveCount(0);
});

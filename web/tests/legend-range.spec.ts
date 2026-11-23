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
  return Number(text.replace(/^[≥≤]\s*/u, ""));
}

test("the colorbar limits can be pinned, rejected when inverted, and reset (#390)", async ({
  page,
}) => {
  // The example opens ready to run (KOF-322); solve it to get a field.
  await page.goto("/app/?example=axial-bar");
  await expect(page.locator("nav")).toBeVisible();
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("colorbar")).toBeVisible();

  // Auto: the ticks span the field's own min/max and nothing is clamped.
  await expect(page.getByTestId("colorbar-manual")).toHaveCount(0);
  expect(await readLegendRange(page)).toBeNull();
  const fieldMax = await tickValue(page, 0);
  expect(fieldMax).toBeGreaterThan(0);

  // Pinning the top of the range to half the peak: the store carries the
  // override, the colorbar says so, and the top tick reads as a clamp. Two
  // significant digits, so the three-digit tick shows the limit exactly.
  const pinnedMax = Number((fieldMax / 2).toPrecision(2));
  // The limits are edited in the popup the legend's pencil opens.
  await page.getByTestId("legend-edit").click();
  await page.getByTestId("legend-max").fill(String(pinnedMax));
  await page.getByTestId("legend-max").press("Enter");

  await expect(page.getByTestId("colorbar-manual")).toBeVisible();
  const range = await readLegendRange(page);
  if (range === null)
    throw new Error("the pinned limits did not reach the store");
  expect(range.max).toBeCloseTo(pinnedMax, 6);
  await expect(page.getByTestId("colorbar-tick-0")).toContainText("≥");
  expect(await tickValue(page, 0)).toBeCloseTo(pinnedMax, 6);

  // An inverted range is refused loudly and leaves the applied limits alone.
  await page.getByTestId("legend-min").fill(String(fieldMax));
  await page.getByTestId("legend-min").press("Enter");
  await expect(page.getByTestId("legend-error")).toContainText(
    "Max must be greater than min",
  );
  const afterReject = await readLegendRange(page);
  if (afterReject === null)
    throw new Error("the rejected edit dropped the applied limits");
  expect(afterReject.max).toBeCloseTo(pinnedMax, 6);

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

test("the colorbar limits apply as you type, without Enter (KOF-384)", async ({
  page,
}) => {
  await page.goto("/app/?example=axial-bar");
  await expect(page.locator("nav")).toBeVisible();
  const run = page.getByRole("button", { name: /Run static solve/ });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.getByTestId("colorbar")).toBeVisible();
  const fieldMax = await tickValue(page, 0);
  expect(fieldMax).toBeGreaterThan(0);

  // A valid value applies with no Enter and no blur, and the text the user
  // typed stays as typed: trailing zeros are not reformatted away.
  const pinnedMax = Number((fieldMax / 2).toPrecision(2));
  const typed = `${pinnedMax.toFixed(6)}0`;
  await page.getByTestId("legend-edit").click();
  const max = page.getByTestId("legend-max");
  await max.fill(typed);
  await expect(page.getByTestId("colorbar-manual")).toBeVisible();
  await expect
    .poll(async () => (await readLegendRange(page))?.max)
    .toBeCloseTo(pinnedMax, 6);
  await expect(max).toBeFocused();
  await expect(max).toHaveValue(typed);
  expect(await tickValue(page, 0)).toBeCloseTo(pinnedMax, 6);

  // An emptied field is partial input: no error, the applied limits stay.
  await max.fill("");
  await expect(max).toHaveValue("");
  const kept = await readLegendRange(page);
  if (kept === null) throw new Error("clearing the field dropped the limits");
  expect(kept.max).toBeCloseTo(pinnedMax, 6);
  await expect(page.getByTestId("legend-error")).toHaveCount(0);

  // Leaving the field with an invalid value shows the error.
  await max.blur();
  await expect(page.getByTestId("legend-error")).toContainText(
    "Both limits must be numbers",
  );

  // A valid value typed afterwards clears the error and applies.
  await max.fill(String(fieldMax));
  await expect(page.getByTestId("legend-error")).toHaveCount(0);
  await expect
    .poll(async () => (await readLegendRange(page))?.max)
    .toBeCloseTo(fieldMax, 6);

  // "Auto" still hands the range back to the field.
  await page.getByTestId("legend-auto").click();
  expect(await readLegendRange(page)).toBeNull();
  await expect(page.getByTestId("colorbar-manual")).toHaveCount(0);
});

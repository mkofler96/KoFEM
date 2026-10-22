// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A Shell body is idealised as shells everywhere, so it must be thin-walled
// everywhere. The crane assembly's holder (body 1) is not: its thin walls carry a
// thick mounting block, about a third of its volume, that no flat wall pair
// describes. Marking the whole holder Shell and meshing must therefore be refused
// by name. Shelling it anyway once dropped that block silently, and the solve
// "converged" on a holder missing the part that carries the load into the hook.
// A user splits the block off into a Solid body first (the split tool).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, expect } from "./coverage";
import { openTree, setElementType } from "./fixtures/tree";

const here = dirname(fileURLToPath(import.meta.url));
const STEP_PATH = join(here, "../../test_files/full-crane-hook.step");

type Store = {
  __kofemStore: {
    getState(): { properties: unknown[]; nodes: unknown[] };
  };
};

test("a crane holder marked Shell whole is refused: its thick block is not a wall", async ({
  page,
}) => {
  test.setTimeout(240_000);

  await page.goto("/app/");
  await expect(page.locator("nav")).toBeVisible();
  await page.setInputFiles('input[accept=".stp,.step"]', STEP_PATH);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as Store).__kofemStore.getState().properties
              .length,
        ),
      { timeout: 60_000 },
    )
    .toBe(3);

  await setElementType(page, 1, "shell");
  await openTree(page, "mesh");
  await page.getByRole("button", { name: /Mesh STEP volume/i }).click();

  const error = page.getByTestId("meshing-error");
  await expect(error).toContainText('Body 1 is marked "Shell"', {
    timeout: 180_000,
  });
  await expect(error).toContainText("% of its volume");
  await expect(error).toContainText("Split that part into a body of its own");
  // Nothing was stored: no mesh with the block missing.
  expect(
    await page.evaluate(
      () => (window as unknown as Store).__kofemStore.getState().nodes.length,
    ),
  ).toBe(0);
});

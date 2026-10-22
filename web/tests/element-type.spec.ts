// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// Shell idealisation is the per-body Element type and nothing else: an import
// makes every body Solid, whatever its walls look like, and each body — a
// single-body part included — offers the Solid / Shell choice. There is no
// automatic detection to switch off.

import path from "node:path";
import { test, expect } from "./coverage";
import { importStep } from "./fixtures/app";
import { openTree, setElementType } from "./fixtures/tree";

// A solid base plus a 2 mm fin (body 2), and a single-body I-beam.
const FIN_TWO_PARTS = path.resolve("..", "test_files", "fin_two_parts.step");
const I_BEAM = path.resolve("..", "test_files", "I_beam.step");

type Disc = { id: number; discretization?: string; materialId: number }[];

const bodies = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: { getState(): { properties: Disc } };
        }
      ).__kofemStore.getState().properties,
  );

test("an import makes every body Solid; Shell is chosen per body", async ({
  page,
}) => {
  await importStep(page, FIN_TWO_PARTS);
  expect((await bodies(page)).map((p) => p.discretization)).toEqual([
    "solid",
    "solid",
  ]);

  await setElementType(page, 2, "shell");
  expect((await bodies(page)).map((p) => p.discretization)).toEqual([
    "solid",
    "shell",
  ]);

  // The mesh controls carry no shell settings of their own.
  await openTree(page, "mesh");
  await expect(page.getByTestId("max-element-size")).toBeVisible();
  await expect(page.getByText("Automatic shell detection")).toHaveCount(0);
});

test("a single-body part offers the element type too", async ({ page }) => {
  await importStep(page, I_BEAM);
  expect(await bodies(page)).toHaveLength(1);
  await setElementType(page, 1, "shell");
  expect((await bodies(page))[0].discretization).toBe("shell");
});

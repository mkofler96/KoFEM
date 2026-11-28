// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-497: after meshing, the Mesh step shows each body's mean element edge
// length next to the max-size setting, and its volume and mass. The axial-bar
// example is a 1000 × 100 × 100 mm steel bar: 1.00e7 mm³, 78.5 kg.

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { openTree } from "./fixtures/tree";

async function openExample(page: Page): Promise<void> {
  await page.goto("/app/?example=axial-bar");
  await expect(
    page.getByRole("button", { name: /Run static solve/ }),
  ).toBeEnabled();
}

function millimetres(text: string | null): number {
  const match = /([\d.,]+)\s*mm/.exec(text ?? "");
  if (!match) throw new Error(`no length in "${text}"`);
  return Number(match[1].replace(/,/g, ""));
}

test("the mesh step shows each body's mean edge, volume and mass @pipeline", async ({
  page,
}) => {
  await openExample(page);
  await openTree(page, "mesh");

  await expect(page.getByTestId("mesh-body-1-volume")).toHaveText(
    "10,000,000 mm³",
  );
  await expect(page.getByTestId("mesh-body-1-mass")).toHaveText("78.5 kg");

  // Reference: the edge of the regular tetrahedron with the mean element
  // volume, a = (6√2 · V / n)^(1/3). Netgen's max size (25 mm here) is a
  // target, not a cap: face diagonals run longer than it.
  const tets = await page.evaluate(
    () =>
      (
        window as unknown as {
          __kofemStore: { getState(): { elements: unknown[] } };
        }
      ).__kofemStore.getState().elements.length,
  );
  const regular = Math.cbrt((6 * Math.SQRT2 * 1e7) / tets);
  const edge = millimetres(
    await page.getByTestId("mesh-body-1-edge").textContent(),
  );
  expect(Math.abs(edge / regular - 1)).toBeLessThan(0.1);
  // The same number stands next to the max-size field.
  await expect(page.getByTestId("mesh-mean-edge")).toContainText(`${edge} mm`);
});

test("a body whose material has no density shows no mass @pipeline", async ({
  page,
}) => {
  await openExample(page);
  await page.getByTestId("tree-material-1").click();
  await page.getByTitle(/^Stored with the material/).fill("0");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await openTree(page, "mesh");
  await expect(page.getByTestId("mesh-body-1-mass")).toHaveText("No density");
  await expect(page.getByTestId("mesh-body-1-volume")).toHaveText(
    "10,000,000 mm³",
  );
});

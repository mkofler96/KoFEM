// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import fs from "fs";
import path from "path";
import os from "os";
import { bootstrapCantilever } from "./fixtures/cantilever";
import { gotoApp } from "./fixtures/app";

// End-to-end coverage for issue #179: save the full analysis (setup +
// results) to a ParaView-readable .vtu file, restore it into a fresh
// session, and verify the round-trip is byte-identical.

async function saveAnalysis(
  page: import("@playwright/test").Page,
  filePath: string,
): Promise<string> {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save analysis" }).click();
  const download = await downloadPromise;
  await download.saveAs(filePath);
  return fs.readFileSync(filePath, "utf-8");
}

test("save → load → re-save round-trips the analysis losslessly", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kofem-save-load-"));

  // ── 1. Solve the cantilever fixture so the saved file contains results ────
  await bootstrapCantilever(page);
  await page
    .locator("nav")
    .getByRole("button")
    .filter({ hasText: "Solve" })
    .click();
  const solveBtn = page
    .getByRole("button")
    .filter({ hasText: "Run static solve" });
  await expect(solveBtn).toBeEnabled();
  await solveBtn.click();
  await expect(page.getByText(/Max \|U\|/)).toBeVisible({ timeout: 30_000 });

  // ── 2. Save the analysis ──────────────────────────────────────────────────
  const file1 = path.join(tmpDir, "first.vtu");
  const saved1 = await saveAnalysis(page, file1);

  // ParaView-readable VTU with the mesh and result fields
  expect(saved1).toContain('<VTKFile type="UnstructuredGrid"');
  expect(saved1).toContain('Name="Displacement"');
  expect(saved1).toContain('Name="VonMises"');
  expect(saved1).toContain('Name="KoFEM"');

  // ── 3. Restore into a fresh app session via the top-bar load button ──────
  await gotoApp(page);
  await expect(
    page.getByRole("button", { name: "Load analysis" }),
  ).toBeVisible();
  await page.locator('input[type="file"][accept=".vtu"]').setInputFiles(file1);

  // Saved in results mode → restored session shows the result stats again
  await expect(page.getByText(/Max \|U\|/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Cantilever Beam")).toBeVisible();

  // ── 4. Re-save and verify byte-identical output ───────────────────────────
  const file2 = path.join(tmpDir, "second.vtu");
  const saved2 = await saveAnalysis(page, file2);
  expect(saved2).toBe(saved1);

  // ── 5. Re-solve the restored session ─────────────────────────────────────
  // The strongest proof that BCs, loads, materials, and mesh were restored
  // (not just the result fields): running the solver again on the loaded
  // state must reproduce the saved displacement / von Mises fields.
  const readResult = () =>
    page.evaluate(() => {
      const s = (
        window as unknown as {
          __kofemStore: {
            getState(): {
              result: {
                displacements: Float64Array;
                vonMises?: Float64Array;
              } | null;
            };
          };
        }
      ).__kofemStore.getState();
      if (!s.result) throw new Error("no result in store");
      return {
        displacements: Array.from(s.result.displacements),
        vonMises: s.result.vonMises ? Array.from(s.result.vonMises) : null,
      };
    });

  const loaded = await readResult();
  await page
    .locator("nav")
    .getByRole("button")
    .filter({ hasText: "Solve" })
    .click();
  const reSolveBtn = page
    .getByRole("button")
    .filter({ hasText: "Run static solve" });
  await expect(reSolveBtn).toBeEnabled();
  await reSolveBtn.click();
  await expect(page.getByText(/Max \|U\|/)).toBeVisible({ timeout: 30_000 });

  const reSolved = await readResult();
  expect(reSolved.displacements.length).toBe(loaded.displacements.length);
  expect(reSolved.vonMises?.length).toBe(loaded.vonMises?.length);
  for (let i = 0; i < loaded.displacements.length; i++)
    expect(reSolved.displacements[i]).toBeCloseTo(loaded.displacements[i], 12);
  for (let i = 0; i < (loaded.vonMises?.length ?? 0); i++)
    expect(reSolved.vonMises![i]).toBeCloseTo(loaded.vonMises![i], 3);
});

test("loading a non-KoFEM file shows a clear error", async ({ page }) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kofem-save-load-"));
  const bogus = path.join(tmpDir, "bogus.vtu");
  fs.writeFileSync(bogus, "<NotVtk></NotVtk>");

  // The top-bar load surfaces parse errors via a native alert dialog.
  let dialogMessage = "";
  page.on("dialog", (d) => {
    dialogMessage = d.message();
    void d.dismiss();
  });

  await gotoApp(page);
  await page.locator('input[type="file"][accept=".vtu"]').setInputFiles(bogus);

  await expect.poll(() => dialogMessage).toContain("Not a KoFEM analysis file");
});

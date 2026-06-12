import { test, expect } from "./coverage";
import fs from "fs";
import path from "path";
import os from "os";

// End-to-end coverage for issue #179: save the full analysis (setup +
// results) to a ParaView-readable .vtu file, restore it into a fresh
// session, and verify the round-trip is byte-identical.

async function startExample(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Start with example" }).click();
  await expect(page.getByRole("button", { name: "Import STEP" })).toBeVisible();
}

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

  // ── 1. Solve the built-in example so the saved file contains results ──────
  await startExample(page);
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

  // ── 3. Restore into a fresh session from the welcome screen ──────────────
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Open analysis" }),
  ).toBeVisible();
  await page.locator('input[type="file"][accept=".vtu"]').setInputFiles(file1);

  // Saved in results mode → restored session shows the result stats again
  await expect(page.getByText(/Max \|U\|/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Cantilever Beam")).toBeVisible();

  // ── 4. Re-save and verify byte-identical output ───────────────────────────
  const file2 = path.join(tmpDir, "second.vtu");
  const saved2 = await saveAnalysis(page, file2);
  expect(saved2).toBe(saved1);
});

test("loading a non-KoFEM file shows a clear error", async ({ page }) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kofem-save-load-"));
  const bogus = path.join(tmpDir, "bogus.vtu");
  fs.writeFileSync(bogus, "<NotVtk></NotVtk>");

  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Open analysis" }),
  ).toBeVisible();
  await page.locator('input[type="file"][accept=".vtu"]').setInputFiles(bogus);

  await expect(page.getByTestId("analysis-error")).toContainText(
    "Not a KoFEM analysis file",
  );
});

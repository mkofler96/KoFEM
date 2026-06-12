import { test, expect } from "./coverage";
import path from "path";
import fs from "fs";

const STEP_FILE = path.resolve("..", "test_files", "tube.stp");

test("WASM OCC generate_fem_mesh: end-to-end smoke test on built-in example", async ({
  page,
}) => {
  test.setTimeout(120_000);
  test.skip(!fs.existsSync(STEP_FILE), `STEP fixture not found: ${STEP_FILE}`);

  const logs: string[] = [];
  page.on("console", (msg) => {
    const text = `[wasm-unit] ${msg.type()}: ${msg.text()}`;
    console.log(text);
    logs.push(text);
  });
  page.on("pageerror", (e) =>
    console.error(`[wasm-unit] page error: ${e.message}`),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Start with example" }).click();
  await expect(page.getByRole("button", { name: "Import STEP" })).toBeVisible();

  // Load a STEP file so tessellate_step runs and geometry is in WASM memory.
  await page
    .locator('input[type="file"][accept=".stp,.step"]')
    .setInputFiles(STEP_FILE);
  await expect(
    page.getByRole("button").filter({ hasText: "Import STEP" }),
  ).toBeEnabled({ timeout: 60_000 });

  // Wait for __kofem (set synchronously in main.tsx)
  await page.waitForFunction(() => !!(window as any).__kofem);

  const result = (await page.evaluate(async () => {
    return (window as any).__kofem.sendToWorker("test_generate_fem_mesh", {});
  })) as { nodes: number; elements: number; durationMs: number };

  console.log(
    `[wasm-unit] nodes=${result.nodes} elements=${result.elements} durationMs=${result.durationMs}`,
  );
  expect(result.nodes).toBeGreaterThan(0);
  expect(result.elements).toBeGreaterThan(0);
  expect(result.durationMs).toBeLessThan(60_000);
});

import { test, expect } from "./coverage";
import path from "path";
import fs from "fs";
import { importStep } from "./fixtures/app";

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

  // Open the app and import a STEP file so tessellate_step runs and the
  // geometry is in WASM memory.
  await importStep(page, STEP_FILE);

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

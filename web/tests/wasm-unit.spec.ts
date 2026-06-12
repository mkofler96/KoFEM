import { test, expect } from "./coverage";

test("WASM OCC generate_fem_mesh: end-to-end smoke test on built-in example", async ({
  page,
}) => {
  test.setTimeout(120_000);

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

  // Wait for __kofem to be available (set synchronously in main.tsx).
  // "Start with example" already calls tessellate_step, so the STEP geometry
  // is loaded in WASM memory and generate_fem_mesh can run immediately.
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

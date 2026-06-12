import { test, expect } from "./coverage";

test("WASM Netgen: tetrahedron smoke test completes in < 30s", async ({
  page,
}) => {
  test.setTimeout(60_000);

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

  // Wait for __kofem to be available (set synchronously in main.tsx)
  await page.waitForFunction(() => !!(window as any).__kofem);

  const result = (await page.evaluate(async () => {
    return (window as any).__kofem.sendToWorker("test_netgen", {});
  })) as { nodes: number; elements: number; durationMs: number };

  console.log(
    `[wasm-unit] nodes=${result.nodes} elements=${result.elements} durationMs=${result.durationMs}`,
  );
  expect(result.nodes).toBeGreaterThan(0);
  expect(result.elements).toBeGreaterThan(0);
  expect(result.durationMs).toBeLessThan(30_000);
});

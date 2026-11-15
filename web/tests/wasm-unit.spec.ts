// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import { fixturePath, importStep } from "./fixtures/app";

type MeshTestResult = { nodes: number; elements: number; durationMs: number };

type MeshTestWindow = Window & {
  __kofem: {
    sendToWorker(
      name: "test_generate_fem_mesh",
      payload: Record<string, never>,
    ): Promise<MeshTestResult>;
  };
};

test("WASM OCC generate_fem_mesh: end-to-end smoke test on built-in example", async ({
  page,
}) => {
  const STEP_FILE = fixturePath("tube.stp");

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
  await page.waitForFunction(() => Boolean((window as MeshTestWindow).__kofem));

  const result = await page.evaluate(() =>
    (window as MeshTestWindow).__kofem.sendToWorker(
      "test_generate_fem_mesh",
      {},
    ),
  );

  console.log(
    `[wasm-unit] nodes=${result.nodes} elements=${result.elements} durationMs=${result.durationMs}`,
  );
  expect(result.nodes).toBeGreaterThan(0);
  expect(result.elements).toBeGreaterThan(0);
  expect(result.durationMs).toBeLessThan(60_000);
});

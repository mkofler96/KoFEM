// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { buildCantilever } from "./fixtures/cantilever";
import type { SolvePayload } from "../src/workers/solverTypes";

type Fields = { displacements: number[]; vonMises: number[] };
type Outcome = { fields: Fields } | { error: string };
type TestWindow = Window & {
  __kofem: {
    sendToWorker(
      type: string,
      payload: object,
    ): Promise<{
      displacements: Float64Array;
      vonMises: Float64Array;
    }>;
    resetWorker(): void;
  };
  __cgOutcome?: Outcome;
};

async function startSolve(
  page: Page,
  cap: number,
  model: SolvePayload = buildCantilever(),
) {
  await page.evaluate(
    ({ model, cap }) => {
      const scope = window as TestWindow;
      delete scope.__cgOutcome;
      void scope.__kofem
        .sendToWorker("solve", { ...model, cgIterationLimit: cap })
        .then(
          (result) => {
            scope.__cgOutcome = {
              fields: {
                displacements: Array.from(result.displacements),
                vonMises: Array.from(result.vonMises),
              },
            };
          },
          (error: Error) => {
            scope.__cgOutcome = { error: error.message };
          },
        );
    },
    { model, cap },
  );
}

async function outcome(page: Page): Promise<Outcome> {
  await page.waitForFunction(() => (window as TestWindow).__cgOutcome);
  return page.evaluate(() => (window as TestWindow).__cgOutcome!);
}

test("CG pauses, resumes repeatedly without changing results, and stops explicitly", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await page.goto("/app/");
  await page.waitForFunction(() => Boolean((window as TestWindow).__kofem));
  const baseline = await page.evaluate(async (model) => {
    const result = await (window as TestWindow).__kofem.sendToWorker(
      "solve",
      model,
    );
    return {
      displacements: Array.from(result.displacements),
      vonMises: Array.from(result.vonMises),
    };
  }, buildCantilever());
  const summary = logs.find((line) =>
    /CG converged: \d+ iterations/.test(line),
  );
  expect(summary).toBeDefined();
  const match = /CG converged: (\d+) iterations/.exec(summary!);
  const iterations = Number(match![1]);
  expect(iterations).toBeGreaterThan(10);
  const cap = iterations - 5;
  await startSolve(page, cap);
  const dialog = page.getByRole("dialog", { name: "Keep solving?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`${cap} iterations`);
  await expect(dialog).toContainText("Relative residual");
  await page.screenshot({ path: testInfo.outputPath("cg-continuation.png") });
  const extra = dialog.getByLabel("Extra iterations");
  for (const invalid of ["", "0", "1.5", "1000001"]) {
    await extra.fill(invalid);
    await expect(
      dialog.getByRole("button", { name: "Continue" }),
    ).toBeDisabled();
  }
  // A competing request must fail without entering the suspended WASM stack.
  const busy = await page.evaluate(() =>
    (window as TestWindow).__kofem.sendToWorker("init", {}).then(
      () => "unexpected success",
      (error: Error) => error.message,
    ),
  );
  expect(busy).toContain("busy");
  await extra.fill("1");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toContainText(`${cap + 1} iterations`);
  await extra.fill("1000");
  await dialog.getByRole("button", { name: "Continue" }).click();
  expect(await outcome(page)).toEqual({ fields: baseline });
  await expect(dialog).toBeHidden();

  await startSolve(page, cap);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Stop", exact: true }).click();
  expect(await outcome(page)).toEqual({
    error: expect.stringContaining(
      "Solve stopped by user. The partial result was discarded.",
    ),
  });
  await expect(dialog).toBeHidden();

  // Closing with Escape has the same explicit-stop semantics.
  await startSolve(page, cap);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  expect(await outcome(page)).toEqual({
    error: expect.stringContaining("discarded"),
  });

  // A malformed protocol reply must restore the WASM stack and report an
  // error. Rejecting inside Asyncify's Promise would leave it paused forever.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    let corruptNext = true;
    Worker.prototype.postMessage = function (message: unknown) {
      const request = message as {
        type?: string;
        payload?: { extraIterations: number };
      };
      if (corruptNext && request.type === "cg_continue" && request.payload) {
        request.payload.extraIterations = 1.5;
        corruptNext = false;
      }
      original.call(this, message);
    };
  });
  await startSolve(page, cap);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Continue" }).click();
  expect(await outcome(page)).toEqual({
    error: expect.stringContaining("CG continuation failed"),
  });

  // Cancellation dismisses the prompt, rejects the pending solve, and frees
  // the worker. Its old response must never resume a subsequent operation.
  await startSolve(page, cap);
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as TestWindow).__kofem.resetWorker());
  expect(await outcome(page)).toEqual({
    error: expect.stringContaining("Worker reset"),
  });
  await expect(dialog).toBeHidden();
});

function shellModel(coupled: boolean): SolvePayload {
  const model: SolvePayload = {
    nodes: [],
    elements: [],
    materials: buildCantilever().materials,
    properties: [{ id: 1, materialId: 1, thickness: 0.02 }],
    constraints: [],
    loads: [],
  };
  const nx = 16,
    ny = 4;
  for (let i = 0; i <= nx; ++i)
    for (let j = 0; j <= ny; ++j)
      model.nodes.push({
        id: i * (ny + 1) + j,
        x: (2 * i) / nx,
        y: (0.3 * j) / ny,
        z: 0,
      });
  for (let i = 0; i < nx; ++i)
    for (let j = 0; j < ny; ++j) {
      const first = i * (ny + 1) + j,
        next = first + ny + 1;
      for (const nodeIds of [
        [first, next, next + 1],
        [first, next + 1, first + 1],
      ])
        model.elements.push({
          id: model.elements.length,
          type: "CTRIA3",
          nodeIds,
          propertyId: 1,
        });
    }
  for (let j = 0; j <= ny; ++j) {
    for (let dof = 0; dof < 6; ++dof)
      model.constraints.push({ nodeId: j, dof });
    model.loads.push({ nodeId: nx * (ny + 1) + j, dof: 2, value: 20 });
  }
  if (coupled) {
    // A fixed solid tetrahedron exercises the mixed assembler and its WASM
    // wrapper, while the shell supplies the slowly converging free system.
    const first = model.nodes.length;
    for (const [x, y, z] of [
      [-2, 0, 0],
      [-1, 0, 0],
      [-2, 1, 0],
      [-2, 0, 1],
    ]) {
      const nodeId = model.nodes.length;
      model.nodes.push({ id: nodeId, x, y, z });
      for (let dof = 0; dof < 3; ++dof) model.constraints.push({ nodeId, dof });
    }
    model.properties.push({ id: 2, materialId: 1 });
    model.elements.push({
      id: model.elements.length,
      type: "CTETRA",
      nodeIds: [first, first + 1, first + 2, first + 3],
      propertyId: 2,
    });
  }
  return model;
}

for (const path of ["shell", "coupled"] as const) {
  test(`${path} WASM solve resumes to identical fields and Stop rejects`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));
    await page.goto("/app/");
    await page.waitForFunction(() => Boolean((window as TestWindow).__kofem));
    const model = shellModel(path === "coupled");
    const baseline = await page.evaluate(async (model) => {
      const result = await (window as TestWindow).__kofem.sendToWorker(
        "solve",
        model,
      );
      return {
        displacements: Array.from(result.displacements),
        vonMises: Array.from(result.vonMises),
      };
    }, model);
    const summary = logs.find((line) => line.includes(`[${path}] converged:`));
    expect(summary).toBeDefined();
    const match = /converged: (\d+) iterations/.exec(summary!);
    const cap = Number(match![1]) - 5;
    await startSolve(page, cap, model);
    const dialog = page.getByRole("dialog", { name: "Keep solving?" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Extra iterations").fill("1000");
    await dialog.getByRole("button", { name: "Continue" }).click();
    expect(await outcome(page)).toEqual({ fields: baseline });
    await startSolve(page, cap, model);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Stop", exact: true }).click();
    expect(await outcome(page)).toEqual({
      error: expect.stringContaining("discarded"),
    });
  });
}

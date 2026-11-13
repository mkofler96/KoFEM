// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import type { Page } from "@playwright/test";
import { buildCantilever } from "./fixtures/cantilever";
import type { SolveModel } from "../src/workers/solverTypes";

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
  model: SolveModel = buildCantilever(),
  solverMethod: "amg" | "gauss-seidel" = "gauss-seidel",
) {
  await page.evaluate(
    ({ model, cap, solverMethod }) => {
      const scope = window as TestWindow;
      delete scope.__cgOutcome;
      scope.__kofem
        .sendToWorker("solve", {
          ...model,
          solverMethod,
          cgIterationLimit: cap,
        })
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
    { model, cap, solverMethod },
  );
}

async function outcome(page: Page): Promise<Outcome> {
  await page.waitForFunction(() => (window as TestWindow).__cgOutcome);
  return page.evaluate(() => {
    const result = (window as TestWindow).__cgOutcome;
    if (result === undefined)
      throw new Error("The solve outcome disappeared before it could be read");
    return result;
  });
}

function convergenceIterations(logs: string[], prefix: string): number {
  const summary = logs.find((line) => line.includes(prefix));
  if (summary === undefined)
    throw new Error(`Missing solver convergence log: ${prefix}`);
  const match = /converged: (\d+) iterations/.exec(summary);
  if (match === null)
    throw new Error(`Invalid solver convergence log: ${summary}`);
  const iterations = Number(match[1]);
  if (!Number.isSafeInteger(iterations) || iterations <= 0)
    throw new Error(`Invalid solver iteration count: ${match[1]}`);
  return iterations;
}

test("CG pauses, resumes repeatedly without changing results, and stops explicitly", async ({
  page,
}, testInfo) => {
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await page.goto("/app/");
  await page.waitForFunction(() => Boolean((window as TestWindow).__kofem));
  const baseline = await page.evaluate(async (model) => {
    const result = await (window as TestWindow).__kofem.sendToWorker("solve", {
      ...model,
      solverMethod: "gauss-seidel",
    });
    return {
      displacements: Array.from(result.displacements),
      vonMises: Array.from(result.vonMises),
    };
  }, buildCantilever());
  const iterations = convergenceIterations(logs, "[mfem] CG converged:");
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

function shellModel(coupled: boolean): SolveModel {
  const model: SolveModel = {
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
    const logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));
    await page.goto("/app/");
    await page.waitForFunction(() => Boolean((window as TestWindow).__kofem));
    const model = shellModel(path === "coupled");
    const baseline = await page.evaluate(async (model) => {
      const result = await (window as TestWindow).__kofem.sendToWorker(
        "solve",
        { ...model, solverMethod: "gauss-seidel" },
      );
      return {
        displacements: Array.from(result.displacements),
        vonMises: Array.from(result.vonMises),
      };
    }, model);
    const cap = convergenceIterations(logs, `[${path}] converged:`) - 5;
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

// A linear-tet cantilever (40×4×4 cubes, six tets each, ~3000 DOFs): large
// enough that AMG builds a real hierarchy and needs more than a few iterations.
function tetBeam(): SolveModel {
  const nx = 40,
    ny = 4,
    nz = 4;
  const id = (ix: number, iy: number, iz: number) =>
    ix + (nx + 1) * (iy + (ny + 1) * iz);
  const model: SolveModel = {
    nodes: [],
    elements: [],
    materials: buildCantilever().materials,
    properties: [{ id: 1, materialId: 1 }],
    constraints: [],
    loads: [],
  };
  for (let iz = 0; iz <= nz; iz++)
    for (let iy = 0; iy <= ny; iy++)
      for (let ix = 0; ix <= nx; ix++)
        model.nodes.push({
          id: id(ix, iy, iz),
          x: ix / nx,
          y: (0.1 * iy) / ny,
          z: (0.1 * iz) / nz,
        });
  const kuhn = [
    [0, 1, 3, 7],
    [0, 3, 2, 7],
    [0, 2, 6, 7],
    [0, 6, 4, 7],
    [0, 4, 5, 7],
    [0, 5, 1, 7],
  ];
  for (let iz = 0; iz < nz; iz++)
    for (let iy = 0; iy < ny; iy++)
      for (let ix = 0; ix < nx; ix++) {
        const corner = (bits: number) =>
          id(ix + (bits & 1), iy + ((bits >> 1) & 1), iz + ((bits >> 2) & 1));
        for (const tet of kuhn)
          model.elements.push({
            id: model.elements.length + 1,
            type: "CTETRA",
            nodeIds: tet.map(corner),
            propertyId: 1,
          });
      }
  for (const node of model.nodes) {
    if (node.x === 0)
      for (let dof = 0; dof < 3; dof++)
        model.constraints.push({ nodeId: node.id, dof });
    if (node.x === 1)
      model.loads.push({ nodeId: node.id, dof: 1, value: -400 });
  }
  return model;
}

test("AMG solve logs progress, asks to continue, resumes to identical fields and Stop rejects", async ({
  page,
}) => {
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await page.goto("/app/");
  await page.waitForFunction(() => Boolean((window as TestWindow).__kofem));
  const model = tetBeam();
  const baseline = await page.evaluate(async (model) => {
    const result = await (window as TestWindow).__kofem.sendToWorker("solve", {
      ...model,
      solverMethod: "amg",
    });
    return {
      displacements: Array.from(result.displacements),
      vonMises: Array.from(result.vonMises),
    };
  }, model);
  const iterations = convergenceIterations(logs, "AMG CG converged:");
  expect(iterations).toBeGreaterThan(10);
  expect(
    logs.some((line) =>
      /\[amg\] CG iteration +10: relative residual/.test(line),
    ),
  ).toBe(true);

  // A budget below the need: the same dialog as the MFEM path appears.
  const cap = iterations - 5;
  await startSolve(page, cap, model, "amg");
  const dialog = page.getByRole("dialog", { name: "Keep solving?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`${cap} iterations`);
  await dialog.getByLabel("Extra iterations").fill("1000");
  await dialog.getByRole("button", { name: "Continue" }).click();
  expect(await outcome(page)).toEqual({ fields: baseline });
  await expect(dialog).toBeHidden();

  await startSolve(page, cap, model, "amg");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Stop", exact: true }).click();
  expect(await outcome(page)).toEqual({
    error: expect.stringContaining(
      "Solve stopped by user. The partial result was discarded.",
    ),
  });
  await expect(dialog).toBeHidden();
});

// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// The Solve panel's solver choice: AMG multigrid is preselected and marked
// recommended, it solves linear- and quadratic-tet models through the Rust
// module, it says so when a model is outside its reach, and Gauss–Seidel gives
// the same field.

import type { Page } from "@playwright/test";
import { test, expect } from "./coverage";
import type { SolveModel } from "../src/workers/solverTypes";

interface StoreWindow {
  __kofemStore: {
    getState(): {
      stepBytes: Uint8Array | null;
      result: { displacements: Float64Array } | null;
      isRunning: boolean;
      elementOrder: number;
      properties: { id: number }[];
      setBodyDiscretization(propertyId: number, disc: "solid" | "shell"): void;
      setMode(mode: "solve"): void;
    };
  };
}

async function openCantilever(page: Page) {
  await page.goto("/app/?example=cantilever-beam");
  await page.waitForFunction(
    () =>
      (window as unknown as StoreWindow).__kofemStore.getState().stepBytes !==
      null,
    null,
    { timeout: 15_000 },
  );
}

async function solveAndRead(page: Page): Promise<number[]> {
  await page.getByRole("button", { name: /Run static solve/ }).click();
  await page.waitForFunction(
    () => {
      const st = (window as unknown as StoreWindow).__kofemStore.getState();
      return !st.isRunning && st.result !== null;
    },
    null,
    { timeout: 60_000 },
  );
  return page.evaluate(() =>
    Array.from(
      (window as unknown as StoreWindow).__kofemStore.getState().result
        ?.displacements ?? [],
    ),
  );
}

async function backToSolve(page: Page) {
  await page.evaluate(() =>
    (window as unknown as StoreWindow).__kofemStore.getState().setMode("solve"),
  );
}

test("AMG is the recommended default and matches Gauss–Seidel", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openCantilever(page);

  const select = page.getByTestId("solver-method");
  await expect(select).toHaveValue("amg");
  await expect(select.locator("option:checked")).toHaveText(
    "AMG multigrid (recommended)",
  );

  // A body solved as a shell is outside AMG's reach: the panel says so before
  // the solve.
  const setDiscretization = (disc: "solid" | "shell") =>
    page.evaluate((value) => {
      const state = (window as unknown as StoreWindow).__kofemStore.getState();
      state.setBodyDiscretization(state.properties[0].id, value);
    }, disc);
  await setDiscretization("shell");
  await expect(page.getByTestId("solver-method-note")).toContainText(
    "does not support bodies solved as shells",
  );
  await setDiscretization("solid");

  // The example opens with quadratic elements, which AMG covers: no note, and
  // the solve runs through it.
  expect(
    await page.evaluate(
      () =>
        (window as unknown as StoreWindow).__kofemStore.getState().elementOrder,
    ),
  ).toBe(2);
  await expect(page.getByTestId("solver-method-note")).toHaveCount(0);
  const multigrid = await solveAndRead(page);
  // The solve log survives the switch to Results; go back and read it.
  await backToSolve(page);
  await expect(page.getByText(/tetrahedra \(order 2\)/)).toBeVisible();
  await expect(page.getByText(/AMG CG converged/)).toBeVisible();

  // The same model with Gauss–Seidel gives the same displacements.
  await page.getByTestId("solver-method").selectOption("gauss-seidel");
  const gaussSeidel = await solveAndRead(page);
  await backToSolve(page);
  await expect(page.getByText(/\[mfem\] CG converged/)).toBeVisible();
  await expect(page.getByText(/AMG CG converged/)).toHaveCount(0);

  expect(multigrid.length).toBe(gaussSeidel.length);
  const peak = Math.max(...gaussSeidel.map(Math.abs));
  const difference = Math.max(
    ...gaussSeidel.map((value, i) => Math.abs(value - multigrid[i])),
  );
  expect(peak).toBeGreaterThan(0);
  expect(difference / peak).toBeLessThan(1e-5);
});

interface WorkerWindow {
  __kofem: {
    sendToWorker(
      type: string,
      payload: object,
    ): Promise<{ displacements: Float64Array }>;
  };
}

// A linear-tet cantilever 1 × 0.1 × 0.1 m, clamped at x = 0, its tip face
// coupled kinematically to a reference point that carries a force and a
// moment.
function coupledTetBeam(): SolveModel {
  const [nx, ny, nz] = [10, 2, 2];
  const id = (ix: number, iy: number, iz: number) =>
    ix + (nx + 1) * (iy + (ny + 1) * iz);
  const model: SolveModel = {
    nodes: [],
    elements: [],
    materials: [
      { id: 1, name: "Steel", young: 210e9, poisson: 0.3, density: 7850 },
    ],
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
  const tip = model.nodes.filter((node) => node.x === 1).map((node) => node.id);
  for (const node of model.nodes)
    if (node.x === 0)
      for (let dof = 0; dof < 3; dof++)
        model.constraints.push({ nodeId: node.id, dof });
  const point = model.nodes.length;
  model.nodes.push({ id: point, x: 1, y: 0.05, z: 0.05 });
  model.couplings = [
    {
      name: "Tip",
      kind: "kinematic",
      dofs: [0, 1, 2, 3, 4, 5],
      refNodeId: point,
      faces: [{ nodeIds: tip }],
    },
  ];
  model.loads.push(
    { nodeId: point, dof: 1, value: -1000 },
    { nodeId: point, dof: 3, value: 50 },
  );
  return model;
}

test("a solid model with a coupling solves with AMG and matches Gauss–Seidel", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  await page.goto("/app/");
  await page.waitForFunction(() =>
    Boolean((window as unknown as WorkerWindow).__kofem),
  );
  const model = coupledTetBeam();
  const solve = (solverMethod: "amg" | "gauss-seidel") =>
    page.evaluate(
      async ({ model, solverMethod }) =>
        Array.from(
          (
            await (window as unknown as WorkerWindow).__kofem.sendToWorker(
              "solve",
              { ...model, solverMethod },
            )
          ).displacements,
        ),
      { model, solverMethod },
    );

  const multigrid = await solve("amg");
  expect(logs.some((line) => line.includes("1 couplings"))).toBe(true);
  expect(logs.some((line) => line.includes("AMG CG converged"))).toBe(true);
  expect(logs.some((line) => line.includes("AMG is not available"))).toBe(
    false,
  );
  const gaussSeidel = await solve("gauss-seidel");

  expect(multigrid.length).toBe(gaussSeidel.length);
  const peak = Math.max(...gaussSeidel.map(Math.abs));
  const difference = Math.max(
    ...gaussSeidel.map((value, i) => Math.abs(value - multigrid[i])),
  );
  expect(peak).toBeGreaterThan(0);
  expect(difference / peak).toBeLessThan(1e-5);
});

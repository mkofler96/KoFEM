// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// KOF-353: a solve path that cannot apply a tie or element order 2 refuses the
// model, and the panel says why before the run starts, instead of solving a
// different model than the one the user set up. The row reads exactly as the
// refusal, and there is none before a mesh exists (KOF-460).

import type { Page } from "@playwright/test";
import { test, expect } from "./coverage";
import { bootstrapCantilever } from "./fixtures/cantilever";
import { gotoApp } from "./fixtures/app";
import { fakeImport } from "./fixtures/mesh";
import { openTree } from "./fixtures/tree";
import { shellOrderRefusal } from "../src/lib/solve/refusals";

interface StoreWindow {
  __kofemStore: {
    getState(): {
      stepBytes: Uint8Array | null;
      elementOrder: number;
      properties: { id: number }[];
      elements: { nodeIds: number[] }[];
      setBodyDiscretization(propertyId: number, disc: "solid" | "shell"): void;
      setElementOrder(order: number): void;
    };
    setState(state: object): void;
  };
}

function store(page: Page) {
  return {
    setOrder: (order: number) =>
      page.evaluate((value) => {
        (window as unknown as StoreWindow).__kofemStore
          .getState()
          .setElementOrder(value);
      }, order),
    setDiscretization: (disc: "solid" | "shell") =>
      page.evaluate((value) => {
        const state = (
          window as unknown as StoreWindow
        ).__kofemStore.getState();
        state.setBodyDiscretization(state.properties[0].id, value);
      }, disc),
    // One tie between two faces of the first element: enough for the
    // pre-flight, which reads only that the model declares it.
    addTie: () =>
      page.evaluate(() => {
        const kofem = (window as unknown as StoreWindow).__kofemStore;
        const nodeIds = kofem.getState().elements[0].nodeIds.slice(0, 3);
        kofem.setState({
          tieGroups: [
            {
              id: 1,
              name: "Tie1",
              facesA: [{ id: 1, label: "Face 1", nodeIds }],
              facesB: [{ id: 2, label: "Face 2", nodeIds }],
              extent: "full",
              searchDistance: 0.5,
              method: "mpc",
            },
          ],
          nextTieGroupId: 2,
        });
      }),
  };
}

test("Solve panel refuses element order 2 on a body solved as a shell", async ({
  page,
}) => {
  await page.goto("/app/?example=cantilever-beam");
  await page.waitForFunction(
    () =>
      (window as unknown as StoreWindow).__kofemStore.getState().stepBytes !==
      null,
    null,
  );
  const model = store(page);
  const runButton = page.getByRole("button", { name: /Run static solve/ });
  const refusal = page
    .getByTestId("check-fail")
    .filter({ hasText: /element order 2/ });

  await model.setOrder(2);
  await expect(runButton).toBeEnabled();
  await model.setDiscretization("shell");
  await expect(refusal).toHaveText(shellOrderRefusal(2));
  await expect(runButton).toBeDisabled();

  await model.setOrder(1);
  await expect(refusal).toHaveCount(0);
  await expect(runButton).toBeEnabled();
});

test("Solve panel shows no route refusal before the part is meshed", async ({
  page,
}) => {
  await gotoApp(page);
  await fakeImport(page);
  await openTree(page, "static");

  // With no mesh there is no model to route: the mesh row fails, and the
  // supports and loads not set yet, but no row says the solve is refused.
  await expect(page.getByTestId("check-fail")).toHaveText([
    /mesh/i,
    "No boundary conditions",
    "No loads, prescribed displacement or temperature change",
  ]);
});

test("Optimize panel refuses a tied model and names the tie", async ({
  page,
}) => {
  await bootstrapCantilever(page);
  await store(page).addTie();
  await openTree(page, "topopt");

  await expect(
    page.getByText(/Topology optimization does not support ties yet.*"Tie1"/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Run optimization/ }),
  ).toBeDisabled();
});

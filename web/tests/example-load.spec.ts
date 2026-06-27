// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";

// Coverage for the `?example=<id>` deep-link (App.tsx useExampleFromUrl), the
// target of the "Open in KoFEM web" buttons on the examples gallery. Exercises
// the success path plus both guarded failure paths (invalid id, missing file).

type StoreSnapshot = {
  modelName: string;
  nodes: number;
  elements: number;
  hasResult: boolean;
  mode: string;
  bcGroups: number;
  loadGroups: number;
};

function readStore(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const s = (
      window as unknown as {
        __kofemStore: {
          getState(): {
            modelName: string;
            nodes: unknown[];
            elements: unknown[];
            result: unknown;
            mode: string;
            bcGroups: unknown[];
            loadGroups: unknown[];
          };
        };
      }
    ).__kofemStore.getState();
    return {
      modelName: s.modelName,
      nodes: s.nodes.length,
      elements: s.elements.length,
      hasResult: s.result !== null,
      mode: s.mode,
      bcGroups: s.bcGroups.length,
      loadGroups: s.loadGroups.length,
    } satisfies StoreSnapshot;
  });
}

test("?example= loads a pre-solved example into the app", async ({ page }) => {
  test.setTimeout(60_000);

  await page.goto("/app/?example=cantilever-beam");
  await expect(page.locator("nav")).toBeVisible();

  // The example .vtu is fetched, parsed and loaded into the store.
  await expect
    .poll(async () => (await readStore(page)).nodes, { timeout: 15_000 })
    .toBeGreaterThan(0);

  const s = await readStore(page);
  expect(s.modelName).toBe("Cantilever beam under tip load");
  expect(s.elements).toBeGreaterThan(0);
  expect(s.hasResult).toBe(true); // saved in results mode with displacements
  expect(s.mode).toBe("results");
  expect(s.bcGroups).toBe(1); // fixed face restored as a BC group
  expect(s.loadGroups).toBe(1); // tip load restored as a load group

  // The restored result renders the results read-out.
  await expect(page.getByText(/Max \|U\|/)).toBeVisible({ timeout: 10_000 });
});

test("re-solving a loaded example does not trap on its node ids (#288)", async ({
  page,
}) => {
  test.setTimeout(60_000);

  // The example .vtu numbers nodes 1-based, so a node id is NOT its 0-based
  // vertex index. Re-running the solve used to hand those ids to the engine as
  // vertex indices, reading past the vertex array and trapping with "memory
  // access out of bounds". Load the example, then drive a fresh solve straight
  // from the restored store state exactly as the Solve button does.
  await page.goto("/app/?example=cantilever-beam");
  await expect(page.locator("nav")).toBeVisible();
  await page.waitForFunction(
    () => !!(window as unknown as { __kofem?: unknown }).__kofem,
  );
  await expect
    .poll(async () => (await readStore(page)).nodes, { timeout: 15_000 })
    .toBeGreaterThan(0);

  const outcome = await page.evaluate(async () => {
    const win = window as unknown as {
      __kofem: {
        sendToWorker(name: string, payload: object): Promise<unknown>;
      };
      __kofemStore: { getState(): Record<string, unknown> };
    };
    const st = win.__kofemStore.getState();
    try {
      const r = (await win.__kofem.sendToWorker("solve", {
        nodes: st.nodes,
        elements: st.elements,
        materials: st.materials,
        properties: st.properties,
        constraints: st.constraints,
        loads: st.loads,
        surfaceLoads: st.surfaceLoads,
      })) as { displacements: number[]; vonMises: number[] };
      return {
        ok: true as const,
        nNodes: (st.nodes as unknown[]).length,
        nElems: (st.elements as unknown[]).length,
        nDisp: r.displacements.length,
        nVm: r.vonMises.length,
      };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  // The solve must complete — no WASM trap — and return one displacement vector
  // per node and one von Mises scalar per element.
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.nDisp).toBe(outcome.nNodes * 3);
    expect(outcome.nVm).toBe(outcome.nElems);
  }
});

test("?example= with an invalid id is rejected without a fetch", async ({
  page,
}) => {
  let dialogMessage = "";
  page.on("dialog", (d) => {
    dialogMessage = d.message();
    void d.dismiss();
  });

  // A slash fails the /^[\w-]+$/ guard, so no request is made.
  await page.goto("/app/?example=..%2Fsecret");
  await expect(page.locator("nav")).toBeVisible();

  await expect.poll(() => dialogMessage).toContain("Invalid example id");
  // The model stays empty — nothing was loaded.
  expect((await readStore(page)).nodes).toBe(0);
});

test("?example= with an unknown id surfaces a clear load error", async ({
  page,
}) => {
  let dialogMessage = "";
  page.on("dialog", (d) => {
    dialogMessage = d.message();
    void d.dismiss();
  });

  await page.goto("/app/?example=does-not-exist");
  await expect(page.locator("nav")).toBeVisible();

  await expect
    .poll(() => dialogMessage, { timeout: 15_000 })
    .toContain("Could not load example");
  expect((await readStore(page)).nodes).toBe(0);
});

test("the app opens normally when no ?example= is present", async ({
  page,
}) => {
  // Guards the early-return branch of useExampleFromUrl.
  await gotoApp(page);
  expect((await readStore(page)).nodes).toBe(0);
});

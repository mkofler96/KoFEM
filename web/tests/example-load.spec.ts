// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "./coverage";
import { gotoApp } from "./fixtures/app";
import { readFile } from "node:fs/promises";

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
    const state = (
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
      modelName: state.modelName,
      nodes: state.nodes.length,
      elements: state.elements.length,
      hasResult: state.result !== null,
      mode: state.mode,
      bcGroups: state.bcGroups.length,
      loadGroups: state.loadGroups.length,
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

  const snapshot = await readStore(page);
  expect(snapshot.modelName).toBe("Cantilever beam under tip load");
  expect(snapshot.elements).toBeGreaterThan(0);
  expect(snapshot.hasResult).toBe(true); // saved in results mode with displacements
  expect(snapshot.mode).toBe("results");
  expect(snapshot.bcGroups).toBe(1); // fixed face restored as a BC group
  expect(snapshot.loadGroups).toBe(1); // tip load restored as a load group

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
      const res = (await win.__kofem.sendToWorker("solve", {
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
        nDisp: res.displacements.length,
        nVm: res.vonMises.length,
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

test("a pure-shell (CTRIA3) example re-solves through the shell path", async ({
  page,
}) => {
  test.setTimeout(60_000);

  // Loads the CTRIA3 shell plate and re-runs the solve exactly as the Solve
  // button does. This exercises the whole shell pipeline end-to-end: CTRIA3
  // parsing, the edge fallback of rebuildSurfaceLoads (the pulled edge is a
  // node polyline containing no whole facet), the worker's work-equivalent
  // line-load distribution, and the engine's Kirchhoff shell solve. Same mesh,
  // BCs and load derivation as the generator → the fresh field must reproduce
  // the one saved in the .vtu.
  await page.goto("/app/?example=plate-with-hole-shell");
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
    const elements = st.elements as { type: string }[];
    const saved = st.result as { displacements: Float64Array };
    const maxU = (disp: Float64Array): number => {
      let max = 0;
      for (let i = 0; i < disp.length; i += 3)
        max = Math.max(max, Math.hypot(disp[i], disp[i + 1], disp[i + 2]));
      return max;
    };
    try {
      const res = (await win.__kofem.sendToWorker("solve", {
        nodes: st.nodes,
        elements: st.elements,
        materials: st.materials,
        properties: st.properties,
        constraints: st.constraints,
        loads: st.loads,
        surfaceLoads: st.surfaceLoads,
      })) as { displacements: Float64Array; vonMises: Float64Array };
      return {
        ok: true as const,
        allShells: elements.every((el) => el.type === "CTRIA3"),
        nNodes: (st.nodes as unknown[]).length,
        nElems: elements.length,
        nDisp: res.displacements.length,
        nVm: res.vonMises.length,
        savedMaxU: maxU(saved.displacements),
        freshMaxU: maxU(res.displacements),
      };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(outcome.allShells).toBe(true); // guard: the file really is a shell model
    expect(outcome.nDisp).toBe(outcome.nNodes * 3);
    expect(outcome.nVm).toBe(outcome.nElems);
    // Identical inputs through a deterministic solver — only summation-order
    // noise is tolerated.
    expect(
      Math.abs(outcome.freshMaxU - outcome.savedMaxU) /
        Math.abs(outcome.savedMaxU),
    ).toBeLessThan(1e-6);
  }
});

test("a mixed shell/solid (CTRIA3 + CTETRA) example re-solves through the coupled path", async ({
  page,
}) => {
  test.setTimeout(180_000);

  // Loads the coupled crane (thin holder as CTRIA3 shells, pin/hook as CTETRA
  // solids) and re-runs the solve exactly as the Solve button does. This
  // exercises the whole mixed shell/solid pipeline end-to-end: mixed-element
  // parsing, the worker's handleMixedSolve (solve_coupled with RBE3 couplings
  // re-derived from proximity), and the field mapping back onto the store nodes /
  // elements. Same pool, BCs and load derivation as the generator → the fresh
  // field must reproduce the one saved in the .vtu.
  const logs: string[] = [];
  page.on("console", (msg) => logs.push(msg.text()));

  await page.goto("/app/?example=crane-hook-shell");
  await expect(page.locator("nav")).toBeVisible();
  await page.waitForFunction(
    () => !!(window as unknown as { __kofem?: unknown }).__kofem,
  );
  await expect
    .poll(async () => (await readStore(page)).nodes, { timeout: 30_000 })
    .toBeGreaterThan(0);

  const outcome = await page.evaluate(async () => {
    const win = window as unknown as {
      __kofem: {
        sendToWorker(name: string, payload: object): Promise<unknown>;
      };
      __kofemStore: { getState(): Record<string, unknown> };
    };
    const st = win.__kofemStore.getState();
    const elements = st.elements as { type: string }[];
    const saved = st.result as { displacements: Float64Array };
    const maxU = (disp: Float64Array): number => {
      let max = 0;
      for (let i = 0; i < disp.length; i += 3)
        max = Math.max(max, Math.hypot(disp[i], disp[i + 1], disp[i + 2]));
      return max;
    };
    try {
      const res = (await win.__kofem.sendToWorker("solve", {
        nodes: st.nodes,
        elements: st.elements,
        materials: st.materials,
        properties: st.properties,
        constraints: st.constraints,
        loads: st.loads,
        surfaceLoads: st.surfaceLoads,
      })) as { displacements: Float64Array; vonMises: Float64Array };
      return {
        ok: true as const,
        nShells: elements.filter((el) => el.type === "CTRIA3").length,
        nSolids: elements.filter((el) => el.type === "CTETRA").length,
        nNodes: (st.nodes as unknown[]).length,
        nElems: elements.length,
        nDisp: res.displacements.length,
        nVm: res.vonMises.length,
        allFinite:
          [...res.displacements].every(Number.isFinite) &&
          [...res.vonMises].every(Number.isFinite),
        savedMaxU: maxU(saved.displacements),
        freshMaxU: maxU(res.displacements),
      };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    // Guard: the file really is a mixed model with both element kinds.
    expect(outcome.nShells).toBeGreaterThan(0);
    expect(outcome.nSolids).toBeGreaterThan(0);
    expect(outcome.nDisp).toBe(outcome.nNodes * 3);
    expect(outcome.nVm).toBe(outcome.nElems);
    expect(outcome.allFinite).toBe(true);
    // The mixed path (not the all-solid fallback) carried the solve.
    expect(logs.some((l) => l.includes("[mixed]"))).toBe(true);
    // The coupled solve re-derives the same couplings from the same pool, so the
    // fresh field reproduces the saved one to within solver-tolerance noise.
    expect(
      Math.abs(outcome.freshMaxU - outcome.savedMaxU) /
        Math.abs(outcome.savedMaxU),
    ).toBeLessThan(1e-3);
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

let EXAMPLE_ANALYSES: { id: string; showcase?: boolean; appId?: string }[];

test.beforeAll(async () => {
  const manifest: { id: string; showcase?: boolean; appId?: string }[] =
    JSON.parse(await readFile("public/examples/examples.json", "utf8"));
  // Showcase entries whose "Open in KoFEM web" points elsewhere (e.g. the
  // coupled crane, which opens its solid assembly) have no <id>.vtu of their
  // own, so they can't be screenshotted. A showcase entry that opens ITSELF
  // (appId === id, e.g. the shell plate) has one and is included.
  EXAMPLE_ANALYSES = manifest.filter(
    (entry) => entry.showcase !== true || entry.appId === entry.id,
  );
});
test("capture screenshots of all examples", async ({ page }) => {
  // Open the app and import the STEP file via the Geometry panel.
  for (const analysis of EXAMPLE_ANALYSES) {
    await page.goto(`/app/?example=${analysis.id}`);

    // Allow the camera reposition and a render frame to settle
    await page.waitForTimeout(100);
    await page
      .getByRole("button", {
        name: "Toggle undeformed overlay",
      })
      .click();
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      const store = (window as any).__kofemStore;
      store.getState().setDeformScale(0);
    });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: `screenshots/${analysis.id}_screenshot.png`,
    });
  }
});
